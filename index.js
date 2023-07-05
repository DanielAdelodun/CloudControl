// // Modal Setup
OperatorID = "Anonymous User"; // Current User

var modalDiv = document.getElementById("TitleModal");
var modal = bootstrap.Modal.getOrCreateInstance(modalDiv)
var PageTitle = document.getElementById("PageTitle");
PageTitle.onclick = function() {
  modal.show();
}

// Change OperatorID (Current User) When Set in Modal
var UserIdInputBtn = document.getElementById("SetOperatorID");
var UserIdInput = document.getElementById("OperatorID");
UserIdInputBtn.addEventListener("click", (event) => {
  if (UserIdInput.value == "") {
    return;
  }
  OperatorID = UserIdInput.value;
  UserIdInput.value = "";
  UserIdInput.placeholder = OperatorID;
  modal.hide();
})
UserIdInput.addEventListener("keyup", (event) => {
  if (event.key === "Enter") {
    if (UserIdInput.value == "") {
      return;
    }
    OperatorID = UserIdInput.value;
    UserIdInput.placeholder = "Operator ID: " + OperatorID;
    UserIdInput.value = "";
  }
})

///////////////////////////////////////////////////////////////////////////////

// //  Create Rotatable Marker & Find Yaw Widget

L.RotatedMarker = L.Marker.extend({
  options: { angle: 0 },
  _setPos: function(pos) {
    L.Marker.prototype._setPos.call(this, pos);
    DroneSVGObject = document.getElementById("drone")
    if (!DroneSVGObject) {
      return;
    }
    DroneSVGDocument = DroneSVGObject.contentDocument;
    if (!DroneSVGDocument || !DroneSVGDocument.getElementById("drone-svg-path")) {
      return;
    }
    DroneSVGPath = DroneSVGDocument.getElementById("drone-svg-path");
    DroneSVGPath.setAttributeNS(null, "transform", "rotate(" + this.options.angle + " 100 90)");
  }
  
});

var droneYawWidget = document.getElementById("drone-rotate-svg");
var droneYawWidgetSetpoint = droneYawWidget.getElementById("yaw-widget-setpoint");
var droneYawWidgetArrow = droneYawWidget.getElementById("yaw-widget-arrow");
var droneYawWidgetOuterRing = droneYawWidget.getElementById("yaw-widget-outer-ring");
var droneYawWidgetInnerRing = droneYawWidget.getElementById("yaw-widget-inner-ring");

///////////////////////////////////////////////////////////////////////////////

// //  Map Layers & Setup

// Mapbox Satellite Streets
const accessToken = 'pk.eyJ1IjoiZGFuaWVsLWFkZWxvZHVuIiwiYSI6ImNsZ3U5MW8wZTFheXAzZm9oYXl5dzNqbjIifQ.qTwBJ1kBAs4YpNu4g-g16A';
const mbUrl = 'https://api.mapbox.com/styles/v1/{id}/tiles/{z}/{x}/{y}?access_token=' + accessToken;
const mbAttr = 'Map data &copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a> contributors, ' +
'<a href="https://creativecommons.org/licenses/by-sa/2.0/">CC-BY-SA</a>, ' +
'Imagery © <a href="https://www.mapbox.com/">Mapbox</a>';
const mapboxLayer = L.tileLayer(mbUrl, {
  maxZoom: 21,
  attribution: mbAttr,
  id: 'mapbox/satellite-streets-v12',
  tileSize: 512,
  zoomOffset: -1,
});

// OpenStreetMap
const osmUrl = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const osmAttr = 'Map data © <a href="https://openstreetmap.org">OpenStreetMap</a> contributors';
const osmLayer = L.tileLayer(osmUrl, {
  maxZoom: 20,
  attribution: osmAttr
});

// Google Satellite
const gUrl = 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}';
const gAttr = 'Map data © <a href="https://maps.google.com">Google Maps</a> contributors';
const googleSat = L.tileLayer(gUrl, {
   maxZoom: 20,
   subdomains:['mt0','mt1','mt2','mt3'],
   attribution: gAttr
  });

const baseLayers = {
  'Street': osmLayer,
  'Satellite': mapboxLayer,
  'Google': googleSat
};

const homeLat = 51.493; 
const homeLon = -0.053;

var droneLat = homeLat;
var droneLon = homeLon;
var droneYaw = 0;
var droneTargetLocation = [homeLat, homeLon];
var droneCurrentLocation = [droneLat, droneLon];

// The Map & Layers
const map = L.map('map', {
  center: [homeLat, homeLon],
  zoom: 18,
  zoomSnap: 0.25,
  zoomDelta: 0.25,
  wheelPxPerZoomLevel: 150,
  layers: [googleSat],
})
L.control.layers(baseLayers).addTo(map);
var targetLayer = L.layerGroup().addTo(map);


const droneIcon = L.divIcon({
  className: 'drone-icon',
  html: '<object class="drone-svg-object" id="drone" data="images/arrow_base.svg" type="image/svg+xml" width="40" height="40"/>',
  iconSize: [40, 40],
  iconAnchor: [20, 20]
});

const blackTargetIcon = L.divIcon({
  className: 'setpoint-icon',
  html: '<object class="setpoint-svg-object" id="setpoint" data="images/marker_border.svg" type="image/svg+xml" width="30" height="30"/>',
  iconSize: [30, 30],
  iconAnchor: [15, 30]
});

const blueTargetIcon = L.icon({
  iconUrl: "images/marker_border_blue.svg",
  iconSize: [30, 30],
  iconAnchor: [15, 30]
});

const droneMarker = new L.RotatedMarker(droneCurrentLocation, {
  icon: droneIcon,
  interactive: false
}).addTo(map).setOpacity(1).setZIndexOffset(501);
const targetLocationMarker = L.marker(droneTargetLocation, {
  icon: blackTargetIcon,
  interactive: false
}).addTo(map).setOpacity(1).setZIndexOffset(500);

// GeoFence
// var GeoFencePolygonPoints = [
//   [51.49344365, -0.05251497],
//   [51.49344866, -0.05283549],
//   [51.49324367, -0.05283549],
//   [51.49325118, -0.05251161],
// ];
var GeoFence = L.circle(
  droneCurrentLocation,
  {
    color: 'red',
    fillOpacity: 0.1,
    fillColor: 'green',
    weight: 1,
    radius: 50,
  }
).addTo(map);


///////////////////////////////////////////////////////////////////////////////

// // Websocket Setup

var FirstLocationMessage = true;
function handleTargetLocation(Msg) {                                 
  droneTargetLocation = Msg.Data;
  if (droneTargetLocation[0] == 0 && droneTargetLocation[1] == 0) { // 0,0 Indicates (likely some kind of Offboard) Error
    targetLocationMarker.setOpacity(0.3);
    return;
  } else {
    targetLocationMarker.setLatLng(droneTargetLocation);
    targetLocationMarker.setOpacity(1);
    targetLayer.clearLayers();
  }
}

function handleTargetYaw(Msg) {
    droneYawWidgetArrow.setAttributeNS(null, "transform", "rotate(" + Msg.Data + "  125 125)");
}

function handleTargetColor(Msg) {
  var colorPicker = document.getElementById("droneLED");
  if (Msg.Data != null) {
    droneYawWidgetOuterRing.setAttributeNS(null, "fill", Msg.Data);
  }
  return
}

function handleSetLocation(Msg) {
  // If Msg.User != Admin then set opacity to 0.3
  if (Msg.User == "Admin") {
    L.marker (
      Msg.Data, 
      { icon: blueTargetIcon }
    ).addTo(targetLayer);
  } else {
    L.marker (
      Msg.Data, 
      { icon: blueTargetIcon, opacity: 0.3}
    ).addTo(targetLayer);
  }
}

function handleOdometery(Msg) {
  if (Msg.Data[0] == 0 && Msg.Data[1] == 0) { // 0,0 Indicates no GPS Lock
    droneMarker.setOpacity(0.5);
    droneLat = Msg.Data[3]; // Use Raw GPS Data
    droneLon = Msg.Data[4];
    droneCurrentLocation = [droneLat, droneLon];
  }
  else {
    droneMarker.setOpacity(1);
    droneLat = Msg.Data[0]; // Use Filtered GPS Data
    droneLon = Msg.Data[1];
    droneCurrentLocation = [droneLat, droneLon];
  }
  droneYaw = Msg.Data[8];

  droneMarker.options.angle = droneYaw;
  droneMarker.setLatLng([droneLat, droneLon]);

  if (FirstLocationMessage) {
    map.setView([droneLat, droneLon], 18);
    GeoFence.setLatLng([droneLat, droneLon]);
    FirstLocationMessage = false;
  }
}

function onMessage(event) {
  var Msg = JSON.parse(event.data);
  console.log(Msg);

  if (Msg.Type == "TargetLocation") {                  // Setpoint Message
    handleTargetLocation(Msg); 
  } else if (Msg.Type == "TargetYaw") {                // Yaw Message
    handleTargetYaw(Msg);
  } else if (Msg.Type == "TargetColor") {
    handleTargetColor(Msg);
  } else if (Msg.Type == "SetLocation") {               // User Target Message
    handleSetLocation(Msg);
  } else if (Msg.Type == "Odometery") {          // Odometery Message
    handleOdometery(Msg);
  }
}

var WebsocketConnection = null;
function persistantConnection() {
  WebsocketConnection = new WebSocket("wss://" + window.location.host + "/ws");
  
  WebsocketConnection.onmessage = onMessage;
  
  WebsocketConnection.onclose = function(event) {
    console.log('Socket is closed. Reconnect will be attempted in 1 second.', event.reason);
    setTimeout(function() {
      persistantConnection();
    }, 1000);
  };
  
  WebsocketConnection.onerror = function(err) {
    console.error('Socket encountered error: ', err.message, 'Closing socket');
    ws.close();
  };
}
persistantConnection();

///////////////////////////////////////////////////////////////////////////////

// // Map Control & GeoFence Toggle

var InsideControl = false;
var EnableGeoFence = true;
var GoToHome = L.Control.extend({
  onAdd: function() {
      var button = L.DomUtil.create('button');
      button.title = 'Go To Setpoint';
      button.classList.add("leaflet-control-layers");
      button.innerHTML = '<object class="setpoint-svg-object" data="images/marker_border_shifted.svg" type="image/svg+xml" width="30" height="30"/>';
      L.DomEvent.on(button, 'click', function () {
        map.flyTo(droneTargetLocation)
      });
      L.DomEvent.on(button, 'mouseenter', function () {
        InsideControl = true;
      });
      L.DomEvent.on(button, 'mouseleave', function () {
        InsideControl = false;
      });
      return button;
  }
});
var GoToDrone = L.Control.extend({
  onAdd: function() {
      var button = L.DomUtil.create('button');
      button.title = 'Go To Drone';
      button.classList.add("leaflet-control-layers");
      button.innerHTML = '<object class="drone-svg-object" data="images/arrow_shifted.svg" type="image/svg+xml" width="30" height="30"/>';
      L.DomEvent.on(button, 'click', function () {
        map.flyTo(droneCurrentLocation)
      });
      L.DomEvent.on(button, 'mouseenter', function () {
        InsideControl = true;
      });
      L.DomEvent.on(button, 'mouseleave', function () {
        InsideControl = false;
      });
      return button;
  }
});
var ToggleGeoFence = L.Control.extend({
onAdd: function() {
    var button = L.DomUtil.create('button');
    button.title = 'Toggle GeoFence';
    button.classList.add("leaflet-control-layers");
    button.innerHTML = '<object class="geofence-svg-object" id="geofence-svg-object" data="images/geofence.svg" type="image/svg+xml" width="30" height="30"/>';
    L.DomEvent.on(button, 'click', function () {
      if (OperatorID == "Admin" || OperatorID == "Operator") {
        EnableGeoFence = !EnableGeoFence;
        var GeoFenceStrikeThrough = document.getElementById("geofence-svg-object").getSVGDocument().getElementById("geofence-strikethrough");
        if (!EnableGeoFence) {
          GeoFenceStrikeThrough.setAttributeNS("", "stroke", "#000000");
        } else {
          map.flyTo(GeoFence.getBounds().getCenter())
          GeoFenceStrikeThrough.setAttributeNS("", "stroke", "");
        }
      }
    });
    L.DomEvent.on(button, 'mouseenter', function () {
      InsideControl = true;
    });
    L.DomEvent.on(button, 'mouseleave', function () {
      InsideControl = false;
    });
    return button;
  }
});
var TakeOff = L.Control.extend({
  onAdd: function() {
      var button = L.DomUtil.create('button');
      button.title = 'Takeoff';
      button.classList.add("leaflet-control-layers");
      button.innerHTML = '<object class="takeoff-svg-object" data="images/takeoff.svg" type="image/svg+xml" width="30" height="30"/>';
      L.DomEvent.on(button, 'click', function () {
        var Msg = {
          Type: "Takeoff",
          User: OperatorID
        };
        WebsocketConnection.send(JSON.stringify(Msg));
      });
      L.DomEvent.on(button, 'mouseenter', function () {
        InsideControl = true;
      });
      L.DomEvent.on(button, 'mouseleave', function () {
        InsideControl = false;
      });
      return button;
  }
});
var Land = L.Control.extend({
  onAdd: function() {
      var button = L.DomUtil.create('button');
      button.title = 'Land';
      button.classList.add("leaflet-control-layers");
      button.innerHTML = '<object class="land-svg-object" data="images/land.svg" type="image/svg+xml" width="30" height="30"/>';
      L.DomEvent.on(button, 'click', function () {
        var Msg = {
          Type: "Land",
          User: OperatorID
        };
        WebsocketConnection.send(JSON.stringify(Msg));
      });
      L.DomEvent.on(button, 'mouseenter', function () {
        InsideControl = true;
      });
      L.DomEvent.on(button, 'mouseleave', function () {
        InsideControl = false;
      });
      return button;
  }
});


var goToHome = (new GoToHome()).addTo(map);
var goToDrone = (new GoToDrone()).addTo(map);
var toggleGeoFence = (new ToggleGeoFence()).addTo(map);
var takeOff = (new TakeOff()).addTo(map);
var land = (new Land()).addTo(map);


///////////////////////////////////////////////////////////////////////////////

// // Flight Control (Location)

GeoFence.on('click', function(event) {
  if (InsideControl) {
    return;
  }
  var Msg = {
    Type: "SetLocation",
    Data: [event.latlng.lat, event.latlng.lng],
    User: OperatorID
  };
  WebsocketConnection.send(JSON.stringify(Msg));
});
map.on('click', function(event) {
  if (InsideControl) {
    return;
  }
  // Outside Geofence Area
  if (!GeoFence.getBounds().contains(event.latlng)) {
    if (EnableGeoFence) {
      var popup = L.popup()
        .setLatLng(event.latlng)
        .setContent("<strong>Outside Geofence Area</strong>")
        .openOn(map);
      return;
    }
    else {
      var Msg = {
        Type: "SetLocation",
        Data: [event.latlng.lat, event.latlng.lng],
        User: OperatorID
      };
      WebsocketConnection.send(JSON.stringify(Msg));
      return;
    }
  }
});

///////////////////////////////////////////////////////////////////////////////

// // Flight Control (Yaw)

var widgetAngle = 0;
var isDragging = false;

function rotateToMouse(event, object, centerX, centerY) {
  var point = new DOMPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  point = point.matrixTransform(droneYawWidget.getScreenCTM().inverse());

  const offsetX = point.x - 125;
  const offsetY = point.y - 125;

  widgetAngle = Math.atan2(offsetY, offsetX) * 180 / Math.PI;
  widgetAngle = widgetAngle + 90;

  object.setAttributeNS(null, "transform", "rotate(" + widgetAngle + " " + centerX + " " + centerY + ")");
  return(widgetAngle)
}

function sendYawAngle() {
  var Msg = {
    Type: "SetYaw",
    Data: widgetAngle,
    User: OperatorID
  };
  WebsocketConnection.send(JSON.stringify(Msg));
}

droneYawWidget.addEventListener("mousedown", (event) => {
  rotateToMouse(event, droneYawWidgetSetpoint, 125, 125);
  isDragging = true;
});
droneYawWidget.addEventListener("touchstart", (event) => {
  event.preventDefault();
  for (var i = 0; i < event.touches.length; i++) {
    rotateToMouse(event.touches[i], droneYawWidgetSetpoint, 125, 125);
  }
  isDragging = true;
});
droneYawWidget.addEventListener("touchmove", (event) => {
  event.preventDefault();
  if (!isDragging) {
    return;
  }
  for (var i = 0; i < event.touches.length; i++) {
    rotateToMouse(event.touches[i], droneYawWidgetSetpoint, 125, 125);
  }
});
// TODO Let The User Drag (Why did this not work?)
droneYawWidget.addEventListener("mousemove", (event) => {
  if (!isDragging) {
    return;
  }
  rotateToMouse(event, droneYawWidgetSetpoint, 125, 125);
});
droneYawWidget.addEventListener("touchend", () => {
  if (isDragging) {
    isDragging = false;
    sendYawAngle();
  }
});
droneYawWidget.addEventListener("touchcancel", () => {
  isDragging = false;
});
droneYawWidget.addEventListener("mouseup", () => {
  if (isDragging) {
    isDragging = false;
    sendYawAngle();
  }
});
droneYawWidget.addEventListener("mouseleave", () => {
  isDragging = false;
});


///////////////////////////////////////////////////////////////////////////////

// // Flight Control (Color)

var colorPicker = document.getElementById("droneLED")
function sendColorPicker(event) {
  const colorMsg = {
    Type: "SetColor",
    Data: event.target.value,
    User: OperatorID,
  };
  WebsocketConnection.send(JSON.stringify(colorMsg));
}
colorPicker.addEventListener("change", sendColorPicker);

// When droneYawWidgetArrow is clicked, send the click the color picker
droneYawWidgetArrow.addEventListener("click", (event) => {
  event.stopPropagation();
  colorPicker.click();
});
droneYawWidgetArrow.addEventListener("mousedown", (event) => {
  event.stopPropagation();
});
droneYawWidgetArrow.addEventListener("touchstart", (event) => {
  event.stopPropagation();
});
