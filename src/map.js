(function() {
  "use strict";

  var TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  var TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  var LAND_MASK_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json";
  var STORAGE_KEY = "fogofwar_last_location";
  var FOG_STORAGE_KEY = "fogofwar_revealed_v1";
  var FOG_STORAGE_VERSION = 1;
  var DEFAULT_CENTER = [39.8283, -98.5795];
  var DEFAULT_ZOOM = 4;
  var LOCATION_ZOOM = 16;
  var MIN_ZOOM = 3;
  var MAX_ZOOM = 19;
  var PAN_PIXELS = 72;
  var FOG_RADIUS_FEET = 400;
  var FOG_RADIUS_METERS = FOG_RADIUS_FEET * 0.3048;
  var FOG_REVEAL_SPACING_METERS = 18;
  var FOG_MAX_POINTS = 5000;
  var FOG_SAVE_DELAY = 800;
  var FOG_MAX_ACCURACY_METERS = 250;
  var FOG_COLOR = "#7a7a7a";
  var FOG_CANVAS_PADDING = 600;
  var FOG_CANVAS_DPR = 1;
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
  var fogLayer = null;
  var fogState = {
    version: FOG_STORAGE_VERSION,
    radiusFeet: FOG_RADIUS_FEET,
    points: []
  };
  var fogSaveTimer = null;
  var landMaskReady = false;
  var landMaskLoading = false;
  var landMaskError = null;
  var landShapes = [];

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
        fogRadiusFeet: FOG_RADIUS_FEET,
        fogRevealedPoints: fogState.points.length,
        landMaskReady: landMaskReady,
        landMaskFeatures: landShapes.length,
        landMaskError: landMaskError,
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

  function createEmptyFogState() {
    return {
      version: FOG_STORAGE_VERSION,
      radiusFeet: FOG_RADIUS_FEET,
      points: []
    };
  }

  function isValidFogPoint(point) {
    return point &&
      typeof point.lat === "number" &&
      typeof point.lng === "number" &&
      isFinite(point.lat) &&
      isFinite(point.lng) &&
      Math.abs(point.lat) <= 90 &&
      Math.abs(point.lng) <= 180;
  }

  function readSavedFogState() {
    try {
      var saved = JSON.parse(localStorage.getItem(FOG_STORAGE_KEY) || "null");
      if (!saved || !Array.isArray(saved.points)) {
        return createEmptyFogState();
      }

      var points = saved.points.filter(isValidFogPoint).slice(-FOG_MAX_POINTS);
      return {
        version: FOG_STORAGE_VERSION,
        radiusFeet: FOG_RADIUS_FEET,
        points: points
      };
    } catch (error) {
      return createEmptyFogState();
    }
  }

  function saveFogStateNow() {
    if (fogSaveTimer !== null) {
      clearTimeout(fogSaveTimer);
      fogSaveTimer = null;
    }

    try {
      localStorage.setItem(FOG_STORAGE_KEY, JSON.stringify({
        version: FOG_STORAGE_VERSION,
        radiusFeet: FOG_RADIUS_FEET,
        updatedAt: Date.now(),
        points: fogState.points
      }));
    } catch (error) {
      console.warn("[Fog]", error && error.message ? error.message : error);
    }
  }

  function scheduleFogSave() {
    if (fogSaveTimer !== null) return;
    fogSaveTimer = setTimeout(saveFogStateNow, FOG_SAVE_DELAY);
  }

  function getRingBounds(ring) {
    var bounds = {
      minLat: 90,
      maxLat: -90,
      minLng: 180,
      maxLng: -180
    };

    for (var i = 0; i < ring.length; i++) {
      var coord = ring[i];
      var lng = coord[0];
      var lat = coord[1];
      if (typeof lat !== "number" || typeof lng !== "number") continue;
      bounds.minLat = Math.min(bounds.minLat, lat);
      bounds.maxLat = Math.max(bounds.maxLat, lat);
      bounds.minLng = Math.min(bounds.minLng, lng);
      bounds.maxLng = Math.max(bounds.maxLng, lng);
    }

    return bounds;
  }

  function addLandPolygon(rings, shapes) {
    if (!Array.isArray(rings) || !rings.length) return;
    var cleanRings = [];
    var bounds = {
      minLat: 90,
      maxLat: -90,
      minLng: 180,
      maxLng: -180
    };

    for (var i = 0; i < rings.length; i++) {
      var ring = rings[i];
      if (!Array.isArray(ring) || ring.length < 3) continue;
      cleanRings.push(ring);
      var ringBounds = getRingBounds(ring);
      bounds.minLat = Math.min(bounds.minLat, ringBounds.minLat);
      bounds.maxLat = Math.max(bounds.maxLat, ringBounds.maxLat);
      bounds.minLng = Math.min(bounds.minLng, ringBounds.minLng);
      bounds.maxLng = Math.max(bounds.maxLng, ringBounds.maxLng);
    }

    if (cleanRings.length) {
      shapes.push({
        rings: cleanRings,
        bounds: bounds
      });
    }
  }

  function addLandGeometry(geometry, shapes) {
    if (!geometry) return;

    if (geometry.type === "Polygon") {
      addLandPolygon(geometry.coordinates, shapes);
    } else if (geometry.type === "MultiPolygon") {
      for (var i = 0; i < geometry.coordinates.length; i++) {
        addLandPolygon(geometry.coordinates[i], shapes);
      }
    } else if (geometry.type === "GeometryCollection") {
      for (var j = 0; j < geometry.geometries.length; j++) {
        addLandGeometry(geometry.geometries[j], shapes);
      }
    }
  }

  function decodeTopoArcs(topology) {
    var scale = topology.transform && topology.transform.scale ? topology.transform.scale : [1, 1];
    var translate = topology.transform && topology.transform.translate ? topology.transform.translate : [0, 0];
    var decoded = [];

    for (var arcIndex = 0; arcIndex < topology.arcs.length; arcIndex++) {
      var arc = topology.arcs[arcIndex];
      var x = 0;
      var y = 0;
      var points = [];

      for (var pointIndex = 0; pointIndex < arc.length; pointIndex++) {
        x += arc[pointIndex][0];
        y += arc[pointIndex][1];
        points.push([
          x * scale[0] + translate[0],
          y * scale[1] + translate[1]
        ]);
      }

      decoded.push(points);
    }

    return decoded;
  }

  function getTopoArc(decodedArcs, arcIndex) {
    if (arcIndex >= 0) return decodedArcs[arcIndex];
    return decodedArcs[~arcIndex].slice().reverse();
  }

  function stitchTopoRing(decodedArcs, arcIndexes) {
    var ring = [];

    for (var i = 0; i < arcIndexes.length; i++) {
      var arc = getTopoArc(decodedArcs, arcIndexes[i]);
      for (var j = 0; j < arc.length; j++) {
        if (ring.length && j === 0) continue;
        ring.push(arc[j]);
      }
    }

    return ring;
  }

  function addTopoPolygon(decodedArcs, polygonArcs, shapes) {
    var rings = [];

    for (var i = 0; i < polygonArcs.length; i++) {
      var ring = stitchTopoRing(decodedArcs, polygonArcs[i]);
      if (ring.length >= 3) rings.push(ring);
    }

    addLandPolygon(rings, shapes);
  }

  function addTopoGeometry(geometry, decodedArcs, shapes) {
    if (!geometry) return;

    if (geometry.type === "Polygon") {
      addTopoPolygon(decodedArcs, geometry.arcs, shapes);
    } else if (geometry.type === "MultiPolygon") {
      for (var i = 0; i < geometry.arcs.length; i++) {
        addTopoPolygon(decodedArcs, geometry.arcs[i], shapes);
      }
    } else if (geometry.type === "GeometryCollection") {
      for (var j = 0; j < geometry.geometries.length; j++) {
        addTopoGeometry(geometry.geometries[j], decodedArcs, shapes);
      }
    }
  }

  function extractTopoLandShapes(topology) {
    var shapes = [];
    if (!topology || !Array.isArray(topology.arcs) || !topology.objects) {
      return shapes;
    }

    var decodedArcs = decodeTopoArcs(topology);
    if (topology.objects.land) {
      addTopoGeometry(topology.objects.land, decodedArcs, shapes);
      return shapes;
    }

    Object.keys(topology.objects).forEach(function(key) {
      addTopoGeometry(topology.objects[key], decodedArcs, shapes);
    });

    return shapes;
  }

  function extractLandShapes(geojson) {
    var shapes = [];
    if (!geojson) return shapes;

    if (geojson.type === "Topology") {
      return extractTopoLandShapes(geojson);
    } else if (geojson.type === "FeatureCollection") {
      for (var i = 0; i < geojson.features.length; i++) {
        addLandGeometry(geojson.features[i] && geojson.features[i].geometry, shapes);
      }
    } else if (geojson.type === "Feature") {
      addLandGeometry(geojson.geometry, shapes);
    } else {
      addLandGeometry(geojson, shapes);
    }

    return shapes;
  }

  function loadLandMask() {
    if (landMaskReady || landMaskLoading) return;
    landMaskLoading = true;
    landMaskError = null;

    fetch(LAND_MASK_URL, {
      cache: "force-cache",
      credentials: "omit"
    }).then(function(response) {
      if (!response.ok) {
        throw new Error("Land mask request failed: " + response.status);
      }
      return response.json();
    }).then(function(geojson) {
      landShapes = extractLandShapes(geojson);
      landMaskReady = landShapes.length > 0;
      landMaskLoading = false;
      if (!landMaskReady) {
        landMaskError = "Land mask had no usable polygons";
      }
      redrawFog();
    }).catch(function(error) {
      landMaskLoading = false;
      landMaskError = error && error.message ? error.message : "Land mask unavailable";
      console.warn("[Fog]", landMaskError);
      redrawFog();
    });
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

  function asLatLng(point) {
    return L.latLng(point.lat, point.lng);
  }

  function roundCoordinate(value) {
    return Number(value.toFixed(6));
  }

  function isNearExistingReveal(latlng) {
    for (var i = fogState.points.length - 1; i >= 0; i--) {
      if (map.distance(latlng, asLatLng(fogState.points[i])) < FOG_REVEAL_SPACING_METERS) {
        return true;
      }
    }

    return false;
  }

  function metersToContainerPixels(latlng, meters) {
    var center = map.latLngToContainerPoint(latlng);
    var latRadians = latlng.lat * Math.PI / 180;
    var lngMeters = 111320 * Math.max(Math.cos(latRadians), 0.01);
    var lngOffset = meters / lngMeters;
    var edge = map.latLngToContainerPoint([latlng.lat, latlng.lng + lngOffset]);
    return Math.max(1, Math.abs(edge.x - center.x));
  }

  function redrawFog() {
    if (fogLayer && typeof fogLayer.redraw === "function") {
      fogLayer.redraw();
    }
  }

  function createFogLayer() {
    if (!map || fogLayer) return;

    var pane = map.createPane("fogPane");
    pane.className += " leaflet-fog-pane";
    pane.style.zIndex = "450";
    pane.style.pointerEvents = "none";

    var FogCanvasLayer = L.Layer.extend({
      onAdd: function(mapInstance) {
        this._map = mapInstance;
        this._canvas = L.DomUtil.create("canvas", "fog-canvas");
        this._ctx = this._canvas.getContext("2d");
        this._frame = null;
        this._bounds = null;
        this._drawOffset = L.point(0, 0);
        this._zooming = false;
        pane.appendChild(this._canvas);

        mapInstance.on("move resize viewreset", this.redraw, this);
        mapInstance.on("zoomstart", this._onZoomStart, this);
        mapInstance.on("zoomend", this._onZoomEnd, this);
        if (mapInstance.options.zoomAnimation && L.Browser.any3d) {
          mapInstance.on("zoomanim", this._animateZoom, this);
        }
        this._reset();
      },

      onRemove: function(mapInstance) {
        mapInstance.off("move resize viewreset", this.redraw, this);
        mapInstance.off("zoomstart", this._onZoomStart, this);
        mapInstance.off("zoomend", this._onZoomEnd, this);
        if (mapInstance.options.zoomAnimation && L.Browser.any3d) {
          mapInstance.off("zoomanim", this._animateZoom, this);
        }
        if (this._frame !== null) {
          cancelAnimationFrame(this._frame);
          this._frame = null;
        }
        L.DomUtil.remove(this._canvas);
      },

      redraw: function() {
        if (this._zooming) return;
        if (this._frame !== null) return;
        var layer = this;
        this._frame = requestAnimationFrame(function() {
          layer._frame = null;
          layer._reset();
        });
      },

      _onZoomStart: function() {
        this._zooming = true;
        if (this._frame !== null) {
          cancelAnimationFrame(this._frame);
          this._frame = null;
        }
      },

      _onZoomEnd: function() {
        this._zooming = false;
        this._reset();
      },

      _animateZoom: function(event) {
        if (!this._canvas || !this._bounds || !this._map._latLngBoundsToNewLayerBounds) return;
        var scale = this._map.getZoomScale(event.zoom);
        var offset = this._map._latLngBoundsToNewLayerBounds(this._bounds, event.zoom, event.center).min;
        L.DomUtil.setTransform(this._canvas, offset, scale);
      },

      _reset: function() {
        if (!this._map || !this._canvas || !this._ctx) return;

        var viewportSize = this._map.getSize();
        var padding = FOG_CANVAS_PADDING;
        var size = L.point(viewportSize.x + padding * 2, viewportSize.y + padding * 2);
        var topLeftContainer = L.point(-padding, -padding);
        var bottomRightContainer = L.point(viewportSize.x + padding, viewportSize.y + padding);
        var topLeft = this._map.containerPointToLayerPoint(topLeftContainer);
        var dpr = FOG_CANVAS_DPR;
        this._bounds = L.latLngBounds(
          this._map.containerPointToLatLng(topLeftContainer),
          this._map.containerPointToLatLng(bottomRightContainer)
        );
        this._drawOffset = L.point(padding, padding);
        L.DomUtil.setPosition(this._canvas, topLeft);

        this._canvas.style.width = size.x + "px";
        this._canvas.style.height = size.y + "px";
        if (this._canvas.width !== Math.round(size.x * dpr) || this._canvas.height !== Math.round(size.y * dpr)) {
          this._canvas.width = Math.round(size.x * dpr);
          this._canvas.height = Math.round(size.y * dpr);
        }

        this._draw(size, dpr);
      },

      _draw: function(size, dpr) {
        var ctx = this._ctx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size.x, size.y);

        if (landMaskReady) {
          this._drawLandFog(ctx, size);
        } else {
          ctx.fillStyle = FOG_COLOR;
          ctx.fillRect(0, 0, size.x, size.y);
        }

        this._cutRevealedAreas(ctx, size);
      },

      _drawLandFog: function(ctx, size) {
        var zoom = this._map.getZoom();
        var worldWidth = this._map.options.crs.scale(zoom);
        var offsets = [-worldWidth, 0, worldWidth];

        ctx.fillStyle = FOG_COLOR;

        for (var shapeIndex = 0; shapeIndex < landShapes.length; shapeIndex++) {
          var shape = landShapes[shapeIndex];

          for (var offsetIndex = 0; offsetIndex < offsets.length; offsetIndex++) {
            var offsetX = offsets[offsetIndex];
            ctx.beginPath();

            for (var ringIndex = 0; ringIndex < shape.rings.length; ringIndex++) {
              var ring = shape.rings[ringIndex];

              for (var pointIndex = 0; pointIndex < ring.length; pointIndex++) {
                var coord = ring[pointIndex];
                var point = this._map.latLngToContainerPoint([coord[1], coord[0]]);
                var x = point.x + offsetX + this._drawOffset.x;
                var y = point.y + this._drawOffset.y;

                if (pointIndex === 0) {
                  ctx.moveTo(x, y);
                } else {
                  ctx.lineTo(x, y);
                }
              }

              ctx.closePath();
            }

            try {
              ctx.fill("evenodd");
            } catch (error) {
              ctx.fill();
            }
          }
        }
      },

      _cutRevealedAreas: function(ctx, size) {
        if (!fogState.points.length) return;

        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath();

        for (var i = 0; i < fogState.points.length; i++) {
          var savedPoint = fogState.points[i];
          var latlng = asLatLng(savedPoint);
          var center = this._map.latLngToContainerPoint(latlng).add(this._drawOffset);
          var radius = metersToContainerPixels(latlng, FOG_RADIUS_METERS);

          if (center.x < -radius || center.x > size.x + radius || center.y < -radius || center.y > size.y + radius) {
            continue;
          }

          ctx.moveTo(center.x + radius, center.y);
          ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
        }

        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
      }
    });

    fogLayer = new FogCanvasLayer();
    fogLayer.addTo(map);
  }

  function revealFogAt(latlng, accuracy) {
    if (!map || !latlng) return;
    if (typeof accuracy === "number" && accuracy > FOG_MAX_ACCURACY_METERS) {
      redrawFog();
      return;
    }

    if (isNearExistingReveal(latlng)) {
      redrawFog();
      return;
    }

    fogState.points.push({
      lat: roundCoordinate(latlng.lat),
      lng: roundCoordinate(latlng.lng),
      at: Date.now()
    });

    if (fogState.points.length > FOG_MAX_POINTS) {
      fogState.points = fogState.points.slice(-FOG_MAX_POINTS);
    }

    scheduleFogSave();
    redrawFog();
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

    fogState = readSavedFogState();
    createFogLayer();
    loadLandMask();

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
    revealFogAt(latlng, accuracy);

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
        saveFogStateNow();
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
      saveFogStateNow();
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
