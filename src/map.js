(function() {
  "use strict";

  var TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  var TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  var STORAGE_KEY = "fogofwar_last_location";
  var DEFAULT_CENTER = [39.8283, -98.5795];
  var DEFAULT_ZOOM = 4;
  var LOCATION_ZOOM = 16;
  var MIN_ZOOM = 3;
  var MAX_ZOOM = 19;
  var PAN_PIXELS = 72;
  var WHEEL_THRESHOLD = 70;
  var GESTURE_ZOOM_STEP = 1.08;
  var DOUBLE_INPUT_WINDOW = 420;
  var FIRST_FIX_TIMEOUT = 45000;
  var WATCH_TIMEOUT = 60000;
  var RETRY_DELAY_MIN = 5000;
  var RETRY_DELAY_MAX = 60000;
  var HEADING_MIN_CHANGE = 2;

  var map = null;
  var marker = null;
  var accuracyCircle = null;
  var watchId = null;
  var orientationListening = false;
  var lastHeading = null;
  var headingSource = null;
  var locationRetryTimer = null;
  var locationRetryDelay = RETRY_DELAY_MIN;
  var lastLocationError = null;
  var locationStartedAt = null;
  var locationPermissionState = "unknown";
  var hasLocation = false;
  var followLocation = true;
  var lastLocation = null;
  var wheelDelta = 0;
  var lastGestureScale = 1;
  var zoomSlider = null;
  var zoomSliderSelected = false;
  var lastRightInputAt = 0;
  var lastLeftInputAt = 0;

  window.fogofwARMap = {
    getState: function() {
      var center = map ? map.getCenter() : null;
      return {
        ready: !!map,
        center: center ? { lat: center.lat, lng: center.lng } : null,
        zoom: map ? map.getZoom() : null,
        hasLocation: hasLocation,
        hasMarker: !!marker,
        followLocation: followLocation,
        geolocationSupported: "geolocation" in navigator,
        watchActive: watchId !== null,
        orientationActive: orientationListening,
        heading: lastHeading,
        headingSource: headingSource,
        zoomSliderSelected: zoomSliderSelected,
        locationPermission: locationPermissionState,
        lastLocationError: lastLocationError
      };
    }
  };

  function readSavedLocation() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved || typeof saved.lat !== "number" || typeof saved.lng !== "number") {
        return null;
      }
      return saved;
    } catch (error) {
      return null;
    }
  }

  function saveLocation(latlng, accuracy) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        lat: latlng.lat,
        lng: latlng.lng,
        accuracy: accuracy || null,
        updatedAt: Date.now()
      }));
    } catch (error) {
      // Storage is optional; location tracking should keep working without it.
    }
  }

  function clampZoom(zoom) {
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
  }

  function getZoomPercent() {
    var zoom = map ? map.getZoom() : DEFAULT_ZOOM;
    return ((clampZoom(zoom) - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)) * 100;
  }

  function updateZoomSlider() {
    if (!zoomSlider) return;
    var zoom = map ? map.getZoom() : DEFAULT_ZOOM;
    zoomSlider.style.setProperty("--zoom-level", getZoomPercent() + "%");
    zoomSlider.setAttribute("aria-valuenow", String(Math.round(zoom)));
  }

  function setZoomSliderSelected(selected) {
    zoomSliderSelected = selected;
    if (!zoomSlider) return;
    zoomSlider.classList.toggle("is-selected", selected);
    if (selected && typeof zoomSlider.focus === "function") {
      zoomSlider.focus({ preventScroll: true });
    } else if (!selected && typeof zoomSlider.blur === "function") {
      zoomSlider.blur();
    }
  }

  function wasQuickInput(previousAt) {
    return previousAt > 0 && Date.now() - previousAt <= DOUBLE_INPUT_WINDOW;
  }

  function recordRightInput() {
    var quick = wasQuickInput(lastRightInputAt);
    lastRightInputAt = Date.now();
    lastLeftInputAt = 0;
    return quick;
  }

  function recordLeftInput() {
    var quick = wasQuickInput(lastLeftInputAt);
    lastLeftInputAt = Date.now();
    lastRightInputAt = 0;
    return quick;
  }

  function normalizeHeading(value) {
    if (typeof value !== "number" || !isFinite(value)) return null;
    return ((value % 360) + 360) % 360;
  }

  function getEventHeading(event) {
    if (typeof event.webkitCompassHeading === "number") {
      return normalizeHeading(event.webkitCompassHeading);
    }

    if (typeof event.alpha === "number") {
      return normalizeHeading(360 - event.alpha);
    }

    return null;
  }

  function headingChanged(nextHeading) {
    if (lastHeading === null) return true;
    var delta = Math.abs(nextHeading - lastHeading);
    return Math.min(delta, 360 - delta) >= HEADING_MIN_CHANGE;
  }

  function applyHeading(heading, source) {
    var normalized = normalizeHeading(heading);
    if (normalized === null || !headingChanged(normalized)) return;

    lastHeading = normalized;
    headingSource = source;
    updateMarkerHeading();
  }

  function updateMarkerHeading() {
    if (!marker || lastHeading === null) return;
    var element = marker.getElement && marker.getElement();
    if (element) {
      element.style.setProperty("--heading-deg", lastHeading + "deg");
      element.classList.add("has-heading");
    }
  }

  function createMap() {
    var saved = readSavedLocation();
    var center = saved ? [saved.lat, saved.lng] : DEFAULT_CENTER;
    var zoom = saved ? LOCATION_ZOOM : DEFAULT_ZOOM;

    map = L.map("map", {
      zoomControl: false,
      attributionControl: true,
      keyboard: false,
      dragging: true,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      touchZoom: "center",
      tap: false,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      zoomSnap: 1,
      zoomDelta: 1,
      inertia: true
    }).setView(center, zoom);

    map.attributionControl.setPrefix(false);

    L.tileLayer(TILE_URL, {
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      attribution: TILE_ATTRIBUTION,
      keepBuffer: 1,
      updateWhenIdle: true
    }).addTo(map);

    map.on("dragstart", function() {
      followLocation = false;
    });

    map.on("zoomend", updateZoomSlider);
    updateZoomSlider();

    requestAnimationFrame(function() {
      map.invalidateSize(false);
    });
  }

  function setLocation(latlng, accuracy) {
    lastLocation = latlng;
    saveLocation(latlng, accuracy);

    if (!marker) {
      marker = L.marker(latlng, {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: "location-marker",
          html: '<span class="location-heading"></span><span class="location-dot"></span>',
          iconSize: [28, 28],
          iconAnchor: [14, 14]
        })
      }).addTo(map);
      updateMarkerHeading();
    } else {
      marker.setLatLng(latlng);
    }

    if (!accuracyCircle) {
      accuracyCircle = L.circle(latlng, {
        radius: accuracy || 12,
        interactive: false,
        color: "#00d4ff",
        weight: 2,
        opacity: 0.72,
        fillColor: "#00d4ff",
        fillOpacity: 0.14
      }).addTo(map);
    } else {
      accuracyCircle.setLatLng(latlng);
      accuracyCircle.setRadius(accuracy || 12);
    }

    if (!hasLocation) {
      hasLocation = true;
      map.setView(latlng, Math.max(map.getZoom(), LOCATION_ZOOM), { animate: false });
      return;
    }

    if (followLocation) {
      map.panTo(latlng, { animate: true, duration: 0.2 });
    }
  }

  function onLocation(position) {
    var coords = position.coords;
    lastLocationError = null;
    locationRetryDelay = RETRY_DELAY_MIN;
    clearLocationRetry();
    if (headingSource !== "orientation" && typeof coords.heading === "number") {
      applyHeading(coords.heading, "gps");
    }
    setLocation(L.latLng(coords.latitude, coords.longitude), coords.accuracy);
  }

  function onDeviceOrientation(event) {
    applyHeading(getEventHeading(event), "orientation");
  }

  function startOrientationTracking() {
    if (orientationListening || !("DeviceOrientationEvent" in window)) {
      return;
    }

    function attach() {
      window.addEventListener("deviceorientation", onDeviceOrientation, true);
      orientationListening = true;
    }

    try {
      if (typeof DeviceOrientationEvent.requestPermission === "function") {
        DeviceOrientationEvent.requestPermission().then(function(state) {
          if (state === "granted") attach();
        }).catch(function(error) {
          console.warn("[Orientation]", error && error.message ? error.message : error);
        });
      } else {
        attach();
      }
    } catch (error) {
      console.warn("[Orientation]", error && error.message ? error.message : error);
    }
  }

  function stopOrientationTracking() {
    if (!orientationListening) return;
    window.removeEventListener("deviceorientation", onDeviceOrientation, true);
    orientationListening = false;
  }

  function onLocationError(error) {
    lastLocationError = {
      code: error && typeof error.code === "number" ? error.code : 0,
      message: error && error.message ? error.message : "Location unavailable",
      at: Date.now()
    };
    console.warn("[Location]", lastLocationError.message);
    scheduleLocationRetry();
  }

  function updateLocationPermissionState() {
    if (!navigator.permissions || !navigator.permissions.query) {
      return;
    }

    try {
      navigator.permissions.query({ name: "geolocation" }).then(function(status) {
        locationPermissionState = status.state || "unknown";
        status.onchange = function() {
          locationPermissionState = status.state || "unknown";
          if (status.state === "granted" && !hasLocation) {
            beginLocationTracking("permission-change");
          }
        };
      }).catch(function() {
        locationPermissionState = "unknown";
      });
    } catch (error) {
      locationPermissionState = "unknown";
    }
  }

  function clearLocationRetry() {
    if (locationRetryTimer !== null) {
      clearTimeout(locationRetryTimer);
      locationRetryTimer = null;
    }
  }

  function scheduleLocationRetry() {
    if (document.hidden || locationRetryTimer !== null || !("geolocation" in navigator)) {
      return;
    }

    var delay = locationRetryDelay;
    locationRetryDelay = Math.min(locationRetryDelay * 2, RETRY_DELAY_MAX);
    locationRetryTimer = setTimeout(function() {
      locationRetryTimer = null;
      beginLocationTracking("retry");
    }, delay);
  }

  function requestCurrentLocation() {
    if (!("geolocation" in navigator)) {
      return;
    }

    try {
      navigator.geolocation.getCurrentPosition(onLocation, onLocationError, {
        enableHighAccuracy: true,
        maximumAge: 60000,
        timeout: FIRST_FIX_TIMEOUT
      });
    } catch (error) {
      onLocationError(error);
    }
  }

  function startLocationWatch(forceRestart) {
    if (!("geolocation" in navigator)) {
      lastLocationError = {
        code: 0,
        message: "Geolocation API unavailable",
        at: Date.now()
      };
      return;
    }

    if (watchId !== null) {
      if (!forceRestart) return;
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }

    locationStartedAt = Date.now();
    try {
      watchId = navigator.geolocation.watchPosition(onLocation, onLocationError, {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: WATCH_TIMEOUT
      });
    } catch (error) {
      watchId = null;
      onLocationError(error);
    }
  }

  function beginLocationTracking(reason) {
    if (document.hidden) return;
    updateLocationPermissionState();
    startOrientationTracking();
    requestCurrentLocation();
    startLocationWatch(reason === "retry");
  }

  function stopLocationWatch() {
    if (watchId !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  }

  function panBy(dx, dy) {
    if (!map) return;
    followLocation = false;
    map.panBy([dx, dy], { animate: true, duration: 0.16 });
  }

  function zoomBy(delta) {
    if (!map) return;
    var nextZoom = clampZoom(map.getZoom() + delta);
    if (nextZoom !== map.getZoom()) {
      map.setZoomAround(map.getCenter(), nextZoom, { animate: true });
      updateZoomSlider();
    }
  }

  function recenter() {
    beginLocationTracking("recenter");
    if (!map || !lastLocation) return;
    followLocation = true;
    map.setView(lastLocation, Math.max(map.getZoom(), LOCATION_ZOOM), { animate: true });
  }

  function handleKeydown(event) {
    if (!hasLocation) beginLocationTracking("keydown");

    switch (event.key) {
      case "ArrowUp":
        if (zoomSliderSelected) {
          zoomBy(1);
        } else {
          panBy(0, -PAN_PIXELS);
        }
        event.preventDefault();
        break;
      case "ArrowDown":
        if (zoomSliderSelected) {
          zoomBy(-1);
        } else {
          panBy(0, PAN_PIXELS);
        }
        event.preventDefault();
        break;
      case "ArrowLeft":
        if (recordLeftInput() && zoomSliderSelected) {
          setZoomSliderSelected(false);
        } else if (!zoomSliderSelected) {
          panBy(-PAN_PIXELS, 0);
        }
        event.preventDefault();
        break;
      case "ArrowRight":
        if (recordRightInput()) {
          setZoomSliderSelected(true);
        } else if (!zoomSliderSelected) {
          panBy(PAN_PIXELS, 0);
        }
        event.preventDefault();
        break;
      case "+":
      case "=":
      case "PageUp":
        zoomBy(1);
        event.preventDefault();
        break;
      case "-":
      case "_":
      case "PageDown":
        zoomBy(-1);
        event.preventDefault();
        break;
      case "Enter":
      case " ":
        recenter();
        event.preventDefault();
        break;
      case "Escape":
      case "Backspace":
      case "BrowserBack":
        zoomBy(-1);
        event.preventDefault();
        break;
      case "0":
      case "Home":
        recenter();
        event.preventDefault();
        break;
      default:
        break;
    }
  }

  function handleWheel(event) {
    if (!map) return;
    if (!hasLocation) beginLocationTracking("wheel");
    event.preventDefault();

    wheelDelta += event.deltaY;
    if (Math.abs(wheelDelta) < WHEEL_THRESHOLD) {
      return;
    }

    zoomBy(wheelDelta < 0 ? 1 : -1);
    wheelDelta = 0;
  }

  function setupGestureZoom() {
    window.addEventListener("gesturestart", function(event) {
      if (!hasLocation) beginLocationTracking("gesture");
      lastGestureScale = event.scale || 1;
      event.preventDefault();
    }, { passive: false });

    window.addEventListener("gesturechange", function(event) {
      var scale = event.scale || 1;
      if (scale >= lastGestureScale * GESTURE_ZOOM_STEP) {
        zoomBy(1);
        lastGestureScale = scale;
      } else if (scale <= lastGestureScale / GESTURE_ZOOM_STEP) {
        zoomBy(-1);
        lastGestureScale = scale;
      }
      event.preventDefault();
    }, { passive: false });
  }

  function setupInput() {
    zoomSlider = document.getElementById("zoom-slider");
    updateZoomSlider();
    document.addEventListener("keydown", handleKeydown);
    window.addEventListener("wheel", handleWheel, { passive: false });
    setupGestureZoom();

    document.addEventListener("visibilitychange", function() {
      if (document.hidden) {
        clearLocationRetry();
        stopLocationWatch();
        stopOrientationTracking();
      } else {
        beginLocationTracking("visible");
        if (map) map.invalidateSize(false);
      }
    });

    window.addEventListener("focus", function() {
      beginLocationTracking("focus");
    });

    window.addEventListener("pageshow", function() {
      beginLocationTracking("pageshow");
    });

    window.addEventListener("beforeunload", function() {
      stopLocationWatch();
      stopOrientationTracking();
    });
    window.addEventListener("resize", function() {
      if (map) map.invalidateSize(false);
    });
  }

  function init() {
    if (!window.L) {
      console.error("[Map] Leaflet failed to load");
      return;
    }

    createMap();
    setupInput();
    beginLocationTracking("init");
  }

  window.addEventListener("DOMContentLoaded", init);
})();
