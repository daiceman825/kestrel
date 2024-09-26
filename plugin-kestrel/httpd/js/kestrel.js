// Author: soliforte
// Email: soliforte@protonmail.com
// Git: github.com/soliforte
// Freeware, enjoy. If you do something really cool with it, let me know. Pull requests encouraged

"use strict";

var local_uri_prefix = "";
if (typeof(KISMET_URI_PREFIX) !== 'undefined')
    local_uri_prefix = KISMET_URI_PREFIX;

// Load last X seconds on initial page load
// Set to 1 to get all previously detected devices
// Set to -60 to get last 60 seconds
const INITIAL_TIMEFRAME = 1
// Load last X seconds on each refresh
const REFRESH_TIMEFRAME = -5
// Interval between refresh (in milliseconds, 1s == 1000ms)
// Recommend to match REFRESH_TIMEFRAME (prevents fetching already mapped updates)
const REFRESH_INTERVAL = 5000

kismet_ui_tabpane.AddTab({
    id: 'kestrel',
    tabTitle: 'Kestrel',
    // expandable: true, // expanding breaks the JS from PruneCluster
    priority: -100,
    createCallback: function (div) {
        $(document).ready(function () {
            $(div).append('<link rel="stylesheet" href="plugin/kestrel/leaflet.css">');
            $(div).append('<script src="plugin/kestrel/js/leaflet.js"></script>');
            $(div).append('<link rel="stylesheet" href="plugin/kestrel/LeafletStyleSheet.css">');
            $(div).append('<script src="plugin/kestrel/js/PruneCluster.js"></script>');
            // $(div).append('<script src="plugin/kestrel/js/leaflet.mouseCoordinate.js">');
            // $(div).append('<link rel="stylesheet" href="plugin/kestrel/js/leaflet.mouseCoordinate.css">');

            // Create our own map container
            // Leaflet doesn't behave properly when using Kismet's tab (CSS issues)
            // Height 100% required or Leaflet won't render and cause other JS errors
            $(div).append('<div id="map-container" style="height:100%;width:100%;"></div>');

            //Instantiate map
            var mapInstance = L.map('map-container').setView([0, 0], 18);
            var mapTileLayer = L.tileLayer('http://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 18,
                attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            }).addTo(mapInstance);

            // L.control.mouseCoordinate({gpsLong:false}).addTo(mapInstance);

            // Event called when Leaflet thinks all visible tiles are loaded
            // Invalidating the size ensures half-visible tiles (grayed areas) are loaded
            mapTileLayer.on('load', function () {
                mapInstance.invalidateSize();
            });

            //Instantiate cluster for le clustering of devices
            var dataCluster = new PruneClusterForLeaflet();
            mapInstance.addLayer(dataCluster);

            //Build custom ClusterIcon
            const colors = ['#ff4b00', '#bac900', '#EC1813', '#55BCBE', '#D2204C', '#FF0000', '#ada59a', '#3e647e']
            const pi2 = Math.PI * 2;
            L.Icon.MarkerCluster = L.Icon.extend({
                options: {
                    iconSize: new L.Point(44, 44),
                    className: 'prunecluster leaflet-markercluster-icon'
                },
                createIcon: function () {
                    // based on L.Icon.Canvas from shramov/leaflet-plugins (BSD licence)
                    var e = document.createElement('canvas');
                    this._setIconStyles(e, 'icon');
                    var s = this.options.iconSize;
                    e.width = s.x;
                    e.height = s.y;
                    this.draw(e.getContext('2d'), s.x, s.y);
                    return e;
                },
                createShadow: function () {
                    return null;
                },
                draw: function (canvas, width, height) {
                    var lol = 0;
                    var start = 0;
                    for (var i = 0, l = colors.length; i < l; ++i) {
                        var size = this.stats[i] / this.population;
                        if (size > 0) {
                            canvas.beginPath();
                            canvas.moveTo(22, 22);
                            canvas.fillStyle = colors[i];
                            var from = start + 0.14,
                            to = start + size * pi2;
                            if (to < from) {
                                from = start;
                            }
                            canvas.arc(22, 22, 22, from, to);
                            start = start + size * pi2;
                            canvas.lineTo(22, 22);
                            canvas.fill();
                            canvas.closePath();
                        }
                    }
                    canvas.beginPath();
                    canvas.fillStyle = 'white';
                    canvas.arc(22, 22, 18, 0, Math.PI * 2);
                    canvas.fill();
                    canvas.closePath();
                    canvas.fillStyle = '#555';
                    canvas.textAlign = 'center';
                    canvas.textBaseline = 'middle';
                    canvas.font = 'bold 12px sans-serif';
                    canvas.fillText(this.population, 22, 22, 40);
                }
            });
            dataCluster.BuildLeafletClusterIcon = function (cluster) {
                var e = new L.Icon.MarkerCluster();
                e.stats = cluster.stats;
                e.population = cluster.population;
                return e;
            };
            
            // Create empty polyline, locations will be added/plotted as GPS updates
            var drivePath = L.polyline([], {
                color: 'blue',
                smoothFactor: 1,
            });
            drivePath.addTo(mapInstance);

            // Create vehicle marker, stage at 0,0 until GPS updates
            var driveMarker = L.marker([0, 0]);
            driveMarker.addTo(mapInstance);

            // Prevent duplicate locations in the drivePath polyline (reduce risk of high cpu/mem usage)
            var previousLocation = [0, 0];
            var mapFitsBounds = false;

            var updateDrivePath = function (data) {
                // console.log(data)
                data = kismet.sanitizeObject(data);

                var currentLocation = [data['kismet.common.location.geopoint'][1],
                    data['kismet.common.location.geopoint'][0]];
                // console.log("currentLocation: " + currentLocation);
                // console.log("previousLocation: " + previousLocation);
                if (!currentLocation ||
                    (!currentLocation[0] && !currentLocation[1]) ||
                    ((currentLocation[0] == previousLocation[0]) && (currentLocation[1] == previousLocation[1]))) {
                    // console.log("Skipped invalid or previous location");
                    return true;
                } else {
                    // console.log("New location: " + currentLocation)
                    drivePath.addLatLng(currentLocation);
                    driveMarker.setLatLng(currentLocation);
                    previousLocation = currentLocation;
                    if (!mapFitsBounds) {
                        // console.log("Fitting drive path within map bounds.")
                        // mapInstance.setView(driveMarker.getLatLng()
                        mapInstance.fitBounds(drivePath.getBounds());
                        mapFitsBounds = true;
                    }
                }
            }
            
            // Get new devices, then plot all devices
            function updateDevices() {
                // Get devices active in last X seconds
                getDevices(REFRESH_TIMEFRAME);
            }

            // Persistant object to prevent duplicate markers
            var devices = {};
            // Persistant object to prevent redraw of all markers every time, move existing markers
            // @todo could be moved to devices[x].marker?
            var markers = {};

            // Gets devices since timestamp (absolute, or relative to now - using negatives)
            function getDevices(ts) {
                const dataJSON = {
                    fields: [
                        'kismet.device.base.name',
                        'kismet.device.base.type',
                        'kismet.device.base.macaddr',
                        'kismet.device.base.manuf',
                        ['kismet.device.base.signal/kismet.common.signal.last_signal', 'base.last.signal'],
                        ['kismet.device.base.location/kismet.common.location.avg_loc/kismet.common.location.geopoint', 'base.location.geopoint'],
                    ],
                    regex: [
                    ["kismet.device.base.type", "^Wi-Fi Device$"],
                    ]
                }
                const postData = "json=" + JSON.stringify(dataJSON);

                $.post(local_uri_prefix + "devices/last-time/" + ts + "/devices.json", postData, "json")
                .done(function (data) {
                    data = kismet.sanitizeObject(data);

                    for (const d of data) {
                        // Skip devices with no location
                        if ((d['base.location.geopoint'] === undefined) ||
                           ((d['base.location.geopoint'][0] == 0) && (d['base.location.geopoint'][1] == 0)))
                            continue;
                        
                        const device = {
                            SSID: d['kismet.device.base.name'],
                            TYPE: d['kismet.device.base.type'],
                            MAC: d['kismet.device.base.macaddr'],
                            RSSI: d['base.last.signal'],
                            LAT: d['base.location.geopoint'][1],
                            LON: d['base.location.geopoint'][0],
                            MANUF: d['kismet.device.base.manuf']
                        };
                        devices[d['kismet.device.base.macaddr']] = device;
                        
                    }
                    
                    plotDevices(devices);
                })
            }; // end of getDevices


            function plotDevices(devices) {
                // dataCluster.RemoveMarkers();
                
                // Get search box value
                const search = $("#devices_filter input").val().toUpperCase();

                //console.log(devices);
                // x should be the mac address
                for (const x in devices) {
                    // Prevent going through prototype chain
                    if (!devices.hasOwnProperty(x))
                        continue;
                    const d = devices[x];
                    
                    // If marker already exists for device, move it as needed, otherwise create new marker
                    if (markers.hasOwnProperty(x)) {
                        if ((markers[x].position.lat !== d['LAT']) || (markers[x].position.lon !== d['LON']))
                            markers[x].Move(d['LAT'], d['LON']);
                    }
                    else {
                        markers[x] = new PruneCluster.Marker(d['LAT'], d['LON']);
                        dataCluster.RegisterMarker(markers[x]);
                        markers[x].data.id = d['MAC'];
                    }
                    
                    if (d['TYPE'] == "Wi-Fi AP") {
                        markers[x].data.icon = L.icon({
                            iconUrl: 'plugin/kestrel/images/ic_router_black_24dp_1x.png',
                            iconSize: [24, 24],
                        });
                        markers[x].category = 1;
                        markers[x].weight = 1;
                    } else if (d['TYPE'] == "Wi-Fi Client") {
                        markers[x].data.icon = L.icon({
                            iconUrl: 'plugin/kestrel/images/ic_laptop_chromebook_black_24dp_1x.png',
                            iconSize: [24, 24],
                        });
                        markers[x].category = 2;
                        markers[x].weight = 1;
                    } else if (d['TYPE'] == "Wi-Fi Bridged") {
                        markers[x].data.icon = L.icon({
                            iconUrl: 'plugin/kestrel/images/ic_power_input_black_24dp_1x.png',
                            iconSize: [24, 24],
                        });
                        markers[x].category = 3;
                        markers[x].weight = 1;
                    } else if (d['TYPE'] == "Wi-Fi WDS") {
                        markers[x].data.icon = L.icon({
                            iconUrl: 'plugin/kestrel/images/ic_leak_add_black_24dp_1x.png',
                            iconSize: [24, 24],
                        });
                        markers[x].category = 3;
                        markers[x].weight = 1;
                    } else if (d['TYPE'] == "Wi-Fi Ad-Hoc") {
                        markers[x].data.icon = L.icon({
                            iconUrl: 'plugin/kestrel/images/ic_cast_connected_black_24dp_1x.png',
                            iconSize: [24, 24],
                        });
                        markers[x].category = 3;
                        markers[x].weight = 1;
                    } else if (d['TYPE'] == "Wi-Fi Device") {
                        markers[x].data.icon = L.icon({
                            iconUrl: 'plugin/kestrel/images/ic_network_check_black_24dp_1x.png',
                            iconSize: [24, 24],
                        });
                        markers[x].category = 3;
                        markers[x].weight = 1;
                    } else if (d['TYPE'] == "") {
                        markers[x].data.icon = L.icon({
                            iconUrl: 'plugin/kestrel/images/ic_network_check_black_24dp_1x.png',
                            iconSize: [24, 24],
                        });
                        markers[x].category = 3;
                        markers[x].weight = 1;
                    } else if (d['TYPE'] == "Wi-Fi Client") {
                        markers[x].data.icon = L.icon({
                            iconUrl: 'plugin/kestrel/images/ic_laptop_chromebook_black_24dp_1x.png',
                            iconSize: [24, 24],
                        });
                        markers[x].category = 3;
                        markers[x].weight = 1;
                    } else {
                        markers[x].data.icon = L.icon({
                            iconUrl: 'plugin/kestrel/images/ic_bluetooth_black_24dp_1x.png',
                            iconSize: [24, 24]
                        });
                        markers[x].category = 5;
                        markers[x].weight = 1;
                    };
                    markers[x].data.popup = `SSID: ${d['SSID']}<br>
                                             MAC: ${d['MAC']}<br>
                                             OUI: ${d['MANUF']}<br>
                                             Type: ${d['TYPE']}<br>
                                             Location: ${d['LAT']}, ${d['LON']}
                                             `;
                    
                    if (d['SSID'].toUpperCase().includes(search)) {
                        markers[x].filtered = false;
                    } else if (d['MAC'].toUpperCase().includes(search)) {
                        markers[x].filtered = false;
                    } else if (d['TYPE'].toUpperCase().includes(search)) {
                        markers[x].filtered = false;
                    } else {
                        markers[x].filtered = true;
                    }
                };
                
                dataCluster.ProcessView();
            } // end of plotDevices

            // Get devices from last X seconds (initial load)
            getDevices(INITIAL_TIMEFRAME);

            // Get new devices every second
            setInterval(updateDevices, REFRESH_INTERVAL);

            // Get an initial GPS location, before relying on the event bus for updates
            $.get(local_uri_prefix + "gps/location.json").done(function (data) {
                updateDrivePath(data);
            });

            // Subscribe to GPS location updates on the event bus
            kismet_ui_base.SubscribeEventbus("GPS_LOCATION", [], function (data) {
                updateDrivePath(data);
            });

            // Create a mutation observer to invalidate the map tiles on panel resize
            // This will prevent grey tiles when resizing (forcing the user to move the map to cause the refresh)
            // We use this method since jQuery UI layout doesn't easily allow for multiple event callbacks, and Kismet already binds onto it
            const targetNode = document.getElementById('kestrel');
            const config = { attributes: true, childList: false, subtree: false };
            const callback = (mutationList, observer) => {
              for (const mutation of mutationList) {
                if (mutation.type === 'attributes') {
                  // jQuery UI Layout changes the style attribute, added height/width as a failsafe
                  if ((mutation.attributeName === 'style') || (mutation.attributeName === 'height') || (mutation.attributeName === 'width')) {
                    mapInstance.invalidateSize();
                  }
                }
              }
            };
            const observer = new MutationObserver(callback);
            observer.observe(targetNode, config);
        }); // end of document.ready
    }, // end of createCallback
}); // end of AddTab
