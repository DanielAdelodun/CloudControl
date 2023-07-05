#!/bin/python3

import json
import sys
import traceback
import random
import asyncio
import websockets
import logging
import os

from mavsdk import System
from mavsdk.offboard import (OffboardError, PositionGlobalYaw)
from mavsdk.telemetry import (Health)
from pymavlink import mavutil
from pymavlink.dialects.v20 import stemstudios      # TODO Remove this when MAVSDK-Python supports custom dialects

# Logging
logFile = r"/var/log/MavlinkWebSockServer.log"
logLevel = logging.DEBUG
fmt = f"%(asctime)s - [%(levelname)s] - %(funcName)s(%(lineno)d) - %(message)s"
fmtShort = f"%(asctime)s - [%(levelname)s] - %(message)s"
formatter = logging.Formatter(fmt)
formatterShort = logging.Formatter(fmtShort)
fileHandler = logging.FileHandler(logFile)
fileHandler.setLevel(logLevel)
fileHandler.setFormatter(formatter)
streamHandler = logging.StreamHandler()
streamHandler.setLevel(logLevel)
streamHandler.setFormatter(formatterShort)
Logger = logging.getLogger("MavlinkWebSockServer")
Logger.addHandler(streamHandler)
Logger.addHandler(fileHandler)
Logger.setLevel(logging.DEBUG)
sys.excepthook = lambda exc, value, tb: Logger.critical("Uncaught Exception!\n%s", "".join(traceback.format_exception(exc, value, tb)))

os.environ['MAVLINK20'] = '1'
try:
    PymavlinkConnection = mavutil.mavlink_connection('tcp:35.178.250.125:5760', dialect='stemstudios', source_system=1, source_component=135)
except Exception as error:
    Logger.error("PyMAVLink Error Connecting to Drone: " + str(error))

# Altitude Type - Relative to Home
REL_HOME = PositionGlobalYaw.AltitudeType.REL_HOME

# Store Websocket Client Connections Here
OpenConnections = set()

IsDroneConnected = False

# Message Types
# SetXYZ -> Client Request to Set XYZ
# TargetXYZ -> Drone Target for XYZ
# CurrentXYZ -> Drone Current XYZ
# Odometery -> Drone Odometery

Parameters = ["Location", "Altitude", "Yaw", "Color"]

# Message Handlers  for Client Requests - <DataTyoe>
## SetLocation - [Latitude, Longitude]
## SetAltitude - Altitude
## SetYaw      - Yaw
## SetColor    - Color

# Every Cycle, Select a Target from the Client Requests
# & Send the Target to the Drone. Then Clear the Client Requests
ClientRequests = {
    "Location": [],
    "Altitude": [],
    "Yaw": [],
    "Color": []
}

# TODO MAVSDK-Python can not get real setpoints/targets from the drone
#      But eventually, we would like DroneTarget to pull directly from the drone
ServerTarget = {
    "Location": [0, 0],
    "Altitude": 5,
    "Yaw": 0,
    "Color": None
}

DroneTarget = ServerTarget.copy()
DroneHealth = Health(False, False, False, False, False, False, False)
TakeoffRequested = False
LandRequested = False

async def HandleSetTarget(Websocket, Message):
    Message = json.loads(Message)
    # TODO Validate Data Types
    ClientRequests[Message["Type"][3:]].append(Message["Data"])
    Logger.debug("New Client Request: " + Message["Type"][3:] + " " + str(Message["Data"]))

async def TakeoffWhenRequested(Drone):
    global TakeoffRequested
    while True:
        if TakeoffRequested:
            try:
                TakeoffRequested = False                
                try:
                    Logger.info("Starting Offboard Mode")
                    await SendPosition(Drone, ServerTarget["Location"], ServerTarget["Altitude"], ServerTarget["Yaw"])
                    await Drone.offboard.start()
                except OffboardError as error:
                    Logger.warning("Error Starting Offboard Mode: " + str(error))
                Logger.debug("Offboard Mode Started")
                await Drone.action.arm()
            except Exception as error:
                Logger.error("Error Arming Drone: " + str(error))
        await asyncio.sleep(0.1)

async def LandWhenRequested(Drone):
    global LandRequested
    while True:
        if LandRequested:
            try:
                LandRequested = False
                Logger.info("Landing Drone")
                await Drone.action.land()
            except Exception as error:
                Logger.error("Error Landing Drone: " + str(error))
        await asyncio.sleep(0.1)

async def ConnectionHandler(Websocket):
    global TakeoffRequested
    global LandRequested

    OpenConnections.add(Websocket)
    ConnectionID = Websocket.response_headers["Sec-WebSocket-Accept"]
    Logger.info("New Connection: " + ConnectionID)
    
    for Param in Parameters:
        await Websocket.send(
            json.dumps({
                "Type": "Target" + Param, 
                "Data": DroneTarget[Param]
            }
        ))
    Logger.debug("Sent Initial Targets to " + ConnectionID)

    try:
        async for Message in Websocket:
            Logger.debug("Received: " + Message + " From " + ConnectionID)
            if json.loads(Message).get("User") == "Admin":
                try:
                    if json.loads(Message).get("Type") == "Takeoff":
                        TakeoffRequested = True
                    elif json.loads(Message).get("Type") == "Land":
                        LandRequested = True
                    else:
                        await HandleSetTarget(Websocket, Message)
                except Exception as error:
                    Logger.warn("Error Handling Client Request: " + str(error))
            websockets.broadcast(OpenConnections, Message)                
    finally:
        Logger.info("Closed: " + ConnectionID)
        OpenConnections.remove(Websocket)

async def SendPosition(Drone, Location, Altitude, Yaw):
    Logger.debug("Sending Position to Drone: " + str(Location) + " Altitude: " + str(Altitude) + " Yaw: " + str(Yaw))
    await Drone.offboard.set_position_global(
        PositionGlobalYaw(
            Location[0], Location[1], Altitude, Yaw, REL_HOME
        )
    )
    Logger.debug("Position Target Sent")

async def SendColor(PyMAVLinkDrone, LEDColorText):
    if LEDColorText == None:
        return
    Logger.debug("Sending Color to Drone: " + str(LEDColorText))
    LEDColor = int(LEDColorText[1:], base=16)
    if LEDColor == 0x123456:
        PyMAVLinkDrone.mav.led_strip_config_send(
            1, 1, 
            stemstudios.LED_FILL_MODE_FOLLOW_FLIGHT_MODE, 
            0, 8, 0, 
            [LEDColor, LEDColor, LEDColor, LEDColor, LEDColor, LEDColor, LEDColor, LEDColor]
        )
    else:
        PyMAVLinkDrone.mav.led_strip_config_send(
            1, 1, 
            stemstudios.LED_FILL_MODE_ALL, 
            0, 8, 0, 
            [LEDColor, LEDColor, LEDColor, LEDColor, LEDColor, LEDColor, LEDColor, LEDColor]
        )

async def SendServerTargetsToDrone(Drone):

    # Select a Target for Each Request Type
    # TODO Validate Data Types & Clear Client Requests Only if Successful
    for RequestType in ClientRequests:
        try:
            ServerTarget[RequestType] = random.choice(ClientRequests[RequestType])
            ClientRequests[RequestType].clear()
        except IndexError:
            Logger.debug("No Client Requests for " + RequestType)

    # Send Each Target to Drone & If Successful, Update DroneTarget
    try:
        await SendPosition(Drone, ServerTarget["Location"], ServerTarget["Altitude"], ServerTarget["Yaw"])
        DroneTarget["Location"] = ServerTarget["Location"]
        DroneTarget["Altitude"] = ServerTarget["Altitude"]
        DroneTarget["Yaw"] = ServerTarget["Yaw"]
    except Exception as error:
        Logger.warning("Error Sending Target Position to Drone: " + str(error))
    
    try:
        await SendColor(PymavlinkConnection, ServerTarget["Color"])
        DroneTarget["Color"] = ServerTarget["Color"]
    except Exception as error:
        Logger.warning("Error Sending Target Color to Drone: " + str(error))

    return

async def SetAndBroadcastDroneTargets(Drone):
    while True:
        await SendServerTargetsToDrone(Drone)
        for Param in Parameters:
            Logger.debug("Broadcasting Target" + Param + ": " + str(DroneTarget[Param]))
            websockets.broadcast(
                OpenConnections,
                json.dumps(
                    {"Type": "Target" + Param, "Data": DroneTarget[Param]}
            ))
        await asyncio.sleep(2)

async def GetDroneHealth(Drone):
    global DroneHealth
    while True:
        Logger.debug("Getting Drone Health")
        async for Health in Drone.telemetry.health():
            DroneHealth = Health
            Logger.debug("Drone Health: " + str(Health))
            break
        await asyncio.sleep(1)

async def BroadcastOdometery(Drone):

    Logger.debug("Starting Odometery Broadcast")

    Odometery = [
        0, 0, 0,    # Position 
        0, 0, 0,    # Raw GPS
        0, 0, 0,    # Attitude (Euler)
        0, 0, 0, 0  # Attitude (Quaternion)
    ]

    while True:
        try:
            if DroneHealth.is_global_position_ok:
                async for Position in Drone.telemetry.position():
                    Odometery[0] = Position.latitude_deg
                    Odometery[1] = Position.longitude_deg
                    Odometery[2] = Position.relative_altitude_m
                    Logger.debug("Position: " + str(Position))
                    break
            else:
                Logger.warning("Global Position Not OK")
                Odometery[0] = 0
                Odometery[1] = 0
                Odometery[2] = 0
            
            async for RawGPS in Drone.telemetry.raw_gps():
                Odometery[3] = RawGPS.latitude_deg
                Odometery[4] = RawGPS.longitude_deg
                Odometery[5] = RawGPS.absolute_altitude_m
                Logger.debug("Raw GPS: " + str(RawGPS))
                break

            async for AttitudeEuler in Drone.telemetry.attitude_euler():
                Odometery[6] = AttitudeEuler.roll_deg
                Odometery[7] = AttitudeEuler.pitch_deg
                Odometery[8] = AttitudeEuler.yaw_deg
                Logger.debug("Attitude Euler: " + str(AttitudeEuler))
                break

            async for AttitudeQuaternion in Drone.telemetry.attitude_quaternion():
                Odometery[9] = AttitudeQuaternion.w
                Odometery[10] = AttitudeQuaternion.x
                Odometery[11] = AttitudeQuaternion.y
                Odometery[12] = AttitudeQuaternion.z
                Logger.debug("Attitude Quaternion: " + str(AttitudeQuaternion))
                break
        except Exception as error:
            Logger.warning("Error Getting Odometery: " + str(error))
            await asyncio.sleep(0.2)
            continue

        Msg = json.dumps({
                "Type": "Odometery",
                "Data": Odometery
            })

        websockets.broadcast(OpenConnections, Msg)
        Logger.debug("Broadcasted Odometery: " + str(Odometery))

    Logger.debug("Stopped Odometery Broadcast")

async def main():

    # Start Websocket Server
    WebsocketServer =  await websockets.serve(ConnectionHandler, "127.0.0.1", 8000)
    print("Server Started")

    ConnectionString = sys.argv[1] if len(sys.argv) > 1 else "tcp://35.178.250.125:5760"

    # Connect to the Drone
    Drone = System()
    await Drone.connect(system_address=ConnectionString)
    print("Connected To Drone")

    # Set The Initial Target To The Drones Current Position Using Raw GPS
    async for RawGPS in Drone.telemetry.raw_gps():
        ServerTarget["Location"] = [RawGPS.latitude_deg, RawGPS.longitude_deg]
        break



    # Start Tasks
    BroadcastOdometeryTask = asyncio.create_task(
        BroadcastOdometery(Drone)
    )
    BroadcastTargetsTask = asyncio.create_task(
        SetAndBroadcastDroneTargets(Drone)
    )

    GlobalPositionOkayTask = asyncio.create_task(
        GetDroneHealth(Drone)
    )

    TakeoffWhenRequestedTask = asyncio.create_task(
        TakeoffWhenRequested(Drone)
    )

    LandWhenRequestedTask = asyncio.create_task(
        LandWhenRequested(Drone)
    )

    # TODO Find out why Odometery Broadcast Task keeps stopping
    # Periodically Restart Odeometery Broadcast Task
    while True:
        await asyncio.sleep(15)
        BroadcastOdometeryTask.cancel()
        BroadcastOdometeryTask = asyncio.create_task(
            BroadcastOdometery(Drone)
        )
        Logger.debug("Restarted Odometery Broadcast Task")

    await BroadcastOdometeryTask
    await BroadcastTargetsTask
    await GlobalPositionOkayTask
    await TakeoffWhenRequestedTask
    await LandWhenRequestedTask
    WebsocketServer.close()
    await WebsocketServer.wait_closed()

if __name__ == "__main__":
    asyncio.run(main())

