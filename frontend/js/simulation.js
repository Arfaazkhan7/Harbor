/**
 * Maritime Emergency Response System — Simulation Ship Module
 * ============================================================
 * Completely independent from the AIS database.
 *
 * Interaction:
 *   1. Click "➕ Add Simulation Ship" → placement mode
 *   2. Click on ocean → ship appears + config modal
 *   3. Click the ship → RADAR circle appears around it
 *   4. Click anywhere inside the radar → ship moves in that direction
 *   5. ESC or click outside → radar closes
 *
 * Global API (window.SimulationShip):
 *   SimulationShip.getData()    → current ship state object
 *   SimulationShip.exists()     → boolean
 *   SimulationShip.onUpdate(fn) → register callback for position changes
 */

const SimulationShip = (function () {
    'use strict';

    // ── Constants ──────────────────────────────────────────────────────────
    const RADAR_RADIUS_PX = 160;    // radar circle screen radius in pixels
    const MOVE_DISTANCE_KM = 3000;   // how far ship moves per click (km, direction only)
    const MIN_RADAR_PX = 8;      // minimum pixels from centre to register a click
    const LAND_CHECK = false;  // allow placing and moving ship anywhere on map

    // ── State ──────────────────────────────────────────────────────────────
    let _map = null;
    let _marker = null;
    let _animFrame = null;
    let _updateCBs = [];
    let _placingMode = false;
    let _radarEl = null;    // active radar SVG DOM element
    let _ship = null;
    let _dragStart = null;
    let _pathArrowGroup = null;

    // ─────────────────────────────────────────────────────────────────────
    // GEO HELPERS
    // ─────────────────────────────────────────────────────────────────────
    function isOnOcean(lat, lon) {
        const OCEAN = [
            { a: 5, b: 65, c: -80, d: -5 },
            { a: -60, b: 5, c: -60, d: 20 },
            { a: 23, b: 30.5, c: -97.5, d: -80 },
            { a: 10, b: 23, c: -88, d: -60 },
            { a: 0, b: 65, c: 130, d: 180 },
            { a: 0, b: 65, c: -180, d: -110 },
            { a: -65, b: 0, c: -110, d: -70 },
            { a: -60, b: 30, c: 20, d: 120 },
            { a: 5, b: 28, c: 50, d: 78 },
            { a: 5, b: 22, c: 79, d: 95 },
            { a: 12, b: 30, c: 32, d: 43.5 },
            { a: 22, b: 30, c: 48, d: 58 },
            { a: 50, b: 62, c: -3, d: 9 },
            { a: 53.5, b: 66, c: 9, d: 30 },
            { a: 48.5, b: 51.5, c: -5.5, d: 2.5 },
            { a: 30, b: 46, c: -6, d: 36.5 },
            { a: 40.5, b: 47, c: 27.5, d: 41.5 },
            { a: 0, b: 23, c: 105, d: 122 },
            { a: 23, b: 33.5, c: 118, d: 132 },
            { a: 33, b: 45, c: 127, d: 142 },
            { a: 1, b: 6.5, c: 98.5, d: 105 },
            { a: 25, b: 45, c: -78, d: -65 },
            { a: 25, b: 49, c: -130, d: -117 },
            { a: -65, b: -55, c: -180, d: 180 },
            { a: 65, b: 90, c: -180, d: 180 },
            { a: -48, b: -30, c: 147, d: 175 },
            { a: -26, b: -8, c: 142, d: 165 },
        ];
        return OCEAN.some(o => lat >= o.a && lat <= o.b && lon >= o.c && lon <= o.d);
    }

    function calcBearing(lat1, lon1, lat2, lon2) {
        const r = Math.PI / 180;
        const dL = (lon2 - lon1) * r;
        const y = Math.sin(dL) * Math.cos(lat2 * r);
        const x = Math.cos(lat1 * r) * Math.sin(lat2 * r)
            - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dL);
        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }

    function haversineKm(lat1, lon1, lat2, lon2) {
        const R = 6371, r = Math.PI / 180;
        const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
        const a = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /** Compute destination point given origin, bearing (deg) and distance (km). */
    function destinationPoint(lat, lon, bearing, distKm) {
        const R = 6371, r = Math.PI / 180;
        const d = distKm / R, b = bearing * r;
        const lat1 = lat * r, lon1 = lon * r;
        const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
        const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
        return { lat: lat2 / r, lon: lon2 / r };
    }

    // ─────────────────────────────────────────────────────────────────────
    // PATH ARROW TRAJECTORY OVERLAY
    // ─────────────────────────────────────────────────────────────────────
    function renderPathArrow(fromLat, fromLon, toLat, toLon, heading) {
        if (!_map) return;

        if (!_pathArrowGroup) {
            _pathArrowGroup = L.layerGroup().addTo(_map);
        } else {
            _pathArrowGroup.clearLayers();
        }

        if (fromLat === undefined || fromLon === undefined || toLat === undefined || toLon === undefined) return;

        const bearing = (heading !== undefined && heading !== null)
            ? heading
            : calcBearing(fromLat, fromLon, toLat, toLon);

        const totalDist = haversineKm(fromLat, fromLon, toLat, toLon);
        if (totalDist < 0.1) return;


        const ARROW_MAX_KM = 150;
        const arrowLengthKm = Math.min(totalDist, ARROW_MAX_KM);
        const tipPoint = destinationPoint(fromLat, fromLon, bearing, arrowLengthKm);


        const line = L.polyline([[fromLat, fromLon], [tipPoint.lat, tipPoint.lon]], {
            color: '#f59e0b',
            weight: 2.5,
            dashArray: '5, 4',
            opacity: 0.9,
            interactive: false
        });
        _pathArrowGroup.addLayer(line);

        // Small, sleek directional arrowhead at the pointer tip
        const arrowHeadIcon = L.divIcon({
            className: 'sim-path-arrow-icon',
            html: `
              <div style="transform: rotate(${bearing}deg); width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M12 2L3 21L12 17L21 21L12 2Z" fill="#f59e0b" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>
                </svg>
              </div>`,
            iconSize: [22, 22],
            iconAnchor: [11, 11]
        });

        const arrowMarker = L.marker([tipPoint.lat, tipPoint.lon], {
            icon: arrowHeadIcon,
            zIndexOffset: 9500,
            interactive: false
        });
        _pathArrowGroup.addLayer(arrowMarker);
    }

    function clearPathArrow() {
        if (_pathArrowGroup && _map) {
            _pathArrowGroup.clearLayers();
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // SHIP ICON
    // ─────────────────────────────────────────────────────────────────────
    function createSimIcon(heading) {
        const rot = (typeof heading === 'number' && heading >= 0) ? heading : 0;
        return L.divIcon({
            className: 'sim-ship-icon',
            html: `
              <div class="sim-ship-wrapper" title="Click to open Radar Navigation">
                <div class="sim-rotator" style="transform:rotate(${rot}deg)">
                  <svg width="36" height="28" viewBox="0 0 36 28" fill="none">
                    <rect x="16.2" y="0" width="2.2" height="7" rx="1" fill="#1e293b"/>
                    <rect x="13.5" y="2" width="7.5" height="2" rx="1" fill="#1e293b"/>
                    <path d="M13 7H21L20 11H14L13 7Z" fill="#fbbf24" stroke="#92400e" stroke-width="1"/>
                    <path d="M10 11H24L27 14H7L10 11Z" fill="#fef3c7" stroke="#92400e" stroke-width="1.2" stroke-linejoin="round"/>
                    <rect x="13" y="11.8" width="2.5" height="2" rx="0.4" fill="#0f172a"/>
                    <rect x="17" y="11.8" width="2.5" height="2" rx="0.4" fill="#0f172a"/>
                    <path d="M4 14H7L10 15.5H27L32 15.5C32.8 15.5 33 16.2 32.5 17L29 22H4.5C3.5 22 3 21.2 3 20.5L3.5 16C3.6 14.8 3.8 14 4 14Z"
                          fill="#f59e0b" stroke="#92400e" stroke-width="1.5" stroke-linejoin="round"/>
                    <line x1="5.5" y1="18.5" x2="22" y2="18.5" stroke="#fef3c7" stroke-width="1.5" stroke-linecap="round"/>
                  </svg>
                </div>
                <div class="sim-ship-label">SIMULATION</div>
              </div>`,
            iconSize: [36, 38],
            iconAnchor: [18, 19],
            popupAnchor: [0, -22]
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // MAP LOCK / UNLOCK
    // ─────────────────────────────────────────────────────────────────────
    function lockMap() {
        if (!_map) return;
        _map.dragging.disable();
        _map.scrollWheelZoom.disable();
        _map.doubleClickZoom.disable();
        _map.boxZoom.disable();
        _map.keyboard.disable();
        if (_map.touchZoom) _map.touchZoom.disable();
        _map.getContainer().classList.add('sim-map-locked');
    }

    function unlockMap() {
        if (!_map) return;
        _map.dragging.enable();
        _map.scrollWheelZoom.enable();
        _map.doubleClickZoom.enable();
        _map.boxZoom.enable();
        _map.keyboard.enable();
        if (_map.touchZoom) _map.touchZoom.enable();
        _map.getContainer().classList.remove('sim-map-locked');
        _map.getContainer().style.cursor = '';
    }

    // ─────────────────────────────────────────────────────────────────────
    // RADAR NAVIGATION SYSTEM
    // ─────────────────────────────────────────────────────────────────────
    function showRadar() {
        if (!_ship || !_map) return;
        hideRadar();
        lockMap();

        const mapRect = _map.getContainer().getBoundingClientRect();
        const shipPt = _map.latLngToContainerPoint([_ship.lat, _ship.lon]);
        const cx = shipPt.x;
        const cy = shipPt.y;
        const R = RADAR_RADIUS_PX;

        // Compute radar scale: km at outer ring edge
        const edgeLL = _map.containerPointToLatLng(L.point(cx + R, cy));
        const centreLL = _map.containerPointToLatLng(L.point(cx, cy));
        const radiusKm = centreLL.distanceTo(edgeLL) / 1000;
        const ring50 = (radiusKm * 0.5).toFixed(0);
        const ring100 = radiusKm.toFixed(0);

        // Build SVG
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.id = 'simRadar';
        svg.style.cssText = [
            'position:fixed',
            `left:${mapRect.left}px`,
            `top:${mapRect.top}px`,
            `width:${mapRect.width}px`,
            `height:${mapRect.height}px`,
            'z-index:3500',
            'overflow:visible'
        ].join(';');

        // SVG defs + radar structure
        svg.innerHTML = `
        <defs>
          <radialGradient id="rdrBg" cx="${cx}" cy="${cy}" r="${R}" gradientUnits="userSpaceOnUse">
            <stop offset="0%"   stop-color="#030d03" stop-opacity="0.45"/>
            <stop offset="85%"  stop-color="#010801" stop-opacity="0.55"/>
            <stop offset="100%" stop-color="#000000" stop-opacity="0.65"/>
          </radialGradient>
          <clipPath id="rdrClip">
            <circle cx="${cx}" cy="${cy}" r="${R}"/>
          </clipPath>
          <filter id="rdrGlow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="1.8" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id="rdrGlowHeavy" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="4" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <marker id="rdrHead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0,0 10,3.5 0,7" fill="#f59e0b"/>
          </marker>
        </defs>

        <!-- Semi-transparent backdrop (click = close radar) -->
        <rect id="rdrBackdrop" x="0" y="0" width="100%" height="100%"
              fill="rgba(0,0,0,0.18)" cursor="default"/>

        <!-- Semi-transparent radar background -->
        <circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#rdrBg)"/>

        <!-- Clipped radar internals -->
        <g clip-path="url(#rdrClip)">

          <!-- Concentric range rings -->
          <circle cx="${cx}" cy="${cy}" r="${R * 0.25}" fill="none" stroke="#00ff41" stroke-width="0.5" opacity="0.3"/>
          <circle cx="${cx}" cy="${cy}" r="${R * 0.5}"  fill="none" stroke="#00ff41" stroke-width="0.6" opacity="0.35"/>
          <circle cx="${cx}" cy="${cy}" r="${R * 0.75}" fill="none" stroke="#00ff41" stroke-width="0.5" opacity="0.3"/>

          <!-- Cardinal cross lines -->
          <line x1="${cx - R}" y1="${cy}" x2="${cx + R}" y2="${cy}" stroke="#00ff41" stroke-width="0.5" opacity="0.25"/>
          <line x1="${cx}" y1="${cy - R}" x2="${cx}" y2="${cy + R}" stroke="#00ff41" stroke-width="0.5" opacity="0.25"/>
          <!-- Diagonal lines -->
          <line x1="${cx - R * 0.707}" y1="${cy - R * 0.707}" x2="${cx + R * 0.707}" y2="${cy + R * 0.707}" stroke="#00ff41" stroke-width="0.4" opacity="0.15"/>
          <line x1="${cx + R * 0.707}" y1="${cy - R * 0.707}" x2="${cx - R * 0.707}" y2="${cy + R * 0.707}" stroke="#00ff41" stroke-width="0.4" opacity="0.15"/>

          <!-- Radar sweep line (CSS animated) -->
          <line id="rdrSweepLine"
                x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - R}"
                stroke="#00ff41" stroke-width="1.8" opacity="0.9"
                style="transform-origin:${cx}px ${cy}px; animation:rdrSpin 4s linear infinite;"/>

          <!-- Dynamic target direction vector line -->
          <line id="rdrArrow" x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy}"
                stroke="#f59e0b" stroke-width="2.5" marker-end="url(#rdrHead)"
                filter="url(#rdrGlowHeavy)" opacity="0"/>

          <!-- Centre ship icon dot -->
          <circle cx="${cx}" cy="${cy}" r="4" fill="#f59e0b" filter="url(#rdrGlow)"/>
          <circle cx="${cx}" cy="${cy}" r="1.5" fill="#ffffff"/>
        </g>

        <!-- Outer compass ring -->
        <circle cx="${cx}" cy="${cy}" r="${R}" fill="none"
                stroke="#00ff41" stroke-width="1.5" opacity="0.6" filter="url(#rdrGlow)"/>

        <!-- Ring range labels -->
        <text x="${cx + 3}" y="${cy - R * 0.5 - 2}" fill="#00ff41" font-size="9"
              font-family="JetBrains Mono,monospace" opacity="0.6">${ring50}km</text>
        <text x="${cx + 3}" y="${cy - R + 11}" fill="#00ff41" font-size="9"
              font-family="JetBrains Mono,monospace" opacity="0.8">${ring100}km</text>

        <!-- Cardinal markers -->
        <text x="${cx}" y="${cy - R - 6}" text-anchor="middle" fill="#00ff41"
              font-size="11" font-family="JetBrains Mono,monospace" font-weight="700">N 000°</text>
        <text x="${cx + R + 10}" y="${cy + 4}" text-anchor="start" fill="#00ff41"
              font-size="11" font-family="JetBrains Mono,monospace" font-weight="700">E 090°</text>
        <text x="${cx}" y="${cy + R + 15}" text-anchor="middle" fill="#00ff41"
              font-size="11" font-family="JetBrains Mono,monospace" font-weight="700">S 180°</text>
        <text x="${cx - R - 10}" y="${cy + 4}" text-anchor="end" fill="#00ff41"
              font-size="11" font-family="JetBrains Mono,monospace" font-weight="700">W 270°</text>

        <!-- Bearing readout (appears on mouse hover inside radar) -->
        <text id="rdrReadout" x="${cx}" y="${cy - R - 20}"
              text-anchor="middle" fill="#f59e0b"
              font-size="13" font-family="JetBrains Mono,monospace" font-weight="700"
              filter="url(#rdrGlow)" opacity="0">000°  0.0 km</text>

        <!-- Ship name + speed HUD -->
        <text x="${cx}" y="${cy + R + 58}" text-anchor="middle"
              fill="#fbbf24" font-size="11" font-family="JetBrains Mono,monospace"
              opacity="0.9">${_ship.name} | ${_ship.speed} kn | LAT: ${_ship.lat.toFixed(4)} LON: ${_ship.lon.toFixed(4)}</text>

        <!-- Action Buttons: Emergency & Stop Ship -->
        <g id="rdrEmergencyBtn" style="cursor:pointer">
          <rect x="${cx - 135}" y="${cy + R + 72}" width="130" height="26" rx="6" fill="#dc2626" stroke="#f87171" stroke-width="1"/>
          <text x="${cx - 70}" y="${cy + R + 89}" text-anchor="middle" fill="#ffffff" font-size="10" font-family="Inter,sans-serif" font-weight="700">🚨 EMERGENCY</text>
        </g>
        <g id="rdrStopBtn" style="cursor:pointer">
          <rect x="${cx + 5}" y="${cy + R + 72}" width="130" height="26" rx="6" fill="#475569" stroke="#94a3b8" stroke-width="1"/>
          <text x="${cx + 70}" y="${cy + R + 89}" text-anchor="middle" fill="#ffffff" font-size="10" font-family="Inter,sans-serif" font-weight="700">🛑 STOP SHIP</text>
        </g>

        <!-- Instruction -->
        <text x="${cx}" y="${cy + R + 114}" text-anchor="middle"
              fill="#94a3b8" font-size="10" font-family="Inter,sans-serif"
              font-style="italic">Click inside radar to set course  •  ESC to cancel</text>

        <!-- Close button -->
        <g id="rdrCloseBtn" style="cursor:pointer">
          <circle cx="${cx + R + 2}" cy="${cy - R + 2}" r="13"
                  fill="#1e293b" stroke="#ef4444" stroke-width="1.8"/>
          <text x="${cx + R + 2}" y="${cy - R + 7}" text-anchor="middle"
                fill="#ef4444" font-size="14" font-weight="700">x</text>
        </g>`;

        document.body.appendChild(svg);
        _radarEl = svg;

        // Emergency button listener
        svg.getElementById('rdrEmergencyBtn').addEventListener('click', (ev) => {
            ev.stopPropagation();
            stopMovement();
            hideRadar();
            if (window.TimeSim) window.TimeSim.showPanel();
            if (window.MaritimeRoute && _ship && _marker) {
                window.MaritimeRoute.triggerEmergencyResponse(_marker, {
                    lat: _ship.lat,
                    lon: _ship.lon,
                    speed: _ship.speed || 15,
                    name: _ship.name || 'Simulation Vessel'
                });
            }
        });

        // ── Event Handlers ──────────────────────────────────────────────

        // Close on backdrop click (outside circle)
        svg.getElementById('rdrBackdrop').addEventListener('click', (ev) => {
            const dx = ev.clientX - mapRect.left - cx;
            const dy = ev.clientY - mapRect.top - cy;
            if (Math.hypot(dx, dy) > R) hideRadar();
        });

        // Close button
        svg.getElementById('rdrCloseBtn').addEventListener('click', (ev) => {
            ev.stopPropagation();
            hideRadar();
        });

        // ── Drag & Click Interaction System ─────────────────────────────────
        let isDragging = false;

        const updateRadarDirection = (clientX, clientY) => {
            const dx = clientX - mapRect.left - cx;
            const dy = clientY - mapRect.top - cy;
            const d = Math.hypot(dx, dy);

            const arrow = svg.getElementById('rdrArrow');
            const readout = svg.getElementById('rdrReadout');

            if (d > R || d < MIN_RADAR_PX) {
                if (arrow) arrow.setAttribute('opacity', '0');
                if (readout) readout.setAttribute('opacity', '0');
                svg.style.cursor = 'default';
                return null;
            }

            svg.style.cursor = 'crosshair';

            // Calculate bearing & distance
            const latlng = _map.mouseEventToLatLng({ clientX, clientY });
            const bearing = calcBearing(_ship.lat, _ship.lon, latlng.lat, latlng.lng);
            const distKm = haversineKm(_ship.lat, _ship.lon, latlng.lat, latlng.lng);

            // Draw arrow from ship centre toward mouse (clipped to R-20)
            const angle = Math.atan2(dy, dx);
            const OFFSET = 12;
            const arrowLen = Math.min(d, R - 20);
            const x2 = cx + Math.cos(angle) * arrowLen;
            const y2 = cy + Math.sin(angle) * arrowLen;

            if (arrow) {
                arrow.setAttribute('x1', cx + Math.cos(angle) * OFFSET);
                arrow.setAttribute('y1', cy + Math.sin(angle) * OFFSET);
                arrow.setAttribute('x2', x2 - Math.cos(angle) * 18);
                arrow.setAttribute('y2', y2 - Math.sin(angle) * 18);
                arrow.setAttribute('opacity', '1');
            }

            if (readout) {
                readout.setAttribute('opacity', '1');
                readout.textContent = `${bearing.toFixed(0).padStart(3, '0')}\u00b0  ${distKm.toFixed(1)} km`;
            }

            // Live ship icon rotation toward cursor
            const el = _marker?.getElement();
            if (el) {
                const rotator = el.querySelector('.sim-rotator');
                if (rotator) rotator.style.transform = `rotate(${bearing}deg)`;
            }

            // Render path arrow on Leaflet map in heading direction
            const dest = destinationPoint(_ship.lat, _ship.lon, bearing, MOVE_DISTANCE_KM);
            renderPathArrow(_ship.lat, _ship.lon, dest.lat, dest.lon, bearing);

            return { bearing, latlng };
        };

        const launchCourse = (clientX, clientY) => {
            const dx = clientX - mapRect.left - cx;
            const dy = clientY - mapRect.top - cy;
            if (Math.hypot(dx, dy) > R || Math.hypot(dx, dy) < MIN_RADAR_PX) return;

            const latlng = _map.mouseEventToLatLng({ clientX, clientY });
            const bearing = calcBearing(_ship.lat, _ship.lon, latlng.lat, latlng.lng);
            const dest = destinationPoint(_ship.lat, _ship.lon, bearing, MOVE_DISTANCE_KM);

            hideRadar();

            if (LAND_CHECK && !isOnOcean(latlng.lat, latlng.lng)) {
                toast('Simulation ship can only travel on navigable water.', 'error');
                return;
            }

            toast(`Course set: ${bearing.toFixed(0)}\u00b0 — launching ship`, 'success');
            startMovement(dest.lat, dest.lon);
        };

        svg.addEventListener('mousedown', (ev) => {
            const dx = ev.clientX - mapRect.left - cx;
            const dy = ev.clientY - mapRect.top - cy;
            if (Math.hypot(dx, dy) <= R && Math.hypot(dx, dy) >= MIN_RADAR_PX) {
                isDragging = true;
                updateRadarDirection(ev.clientX, ev.clientY);
            }
        });

        svg.addEventListener('mousemove', (ev) => {
            updateRadarDirection(ev.clientX, ev.clientY);
        });

        svg.addEventListener('mouseup', (ev) => {
            if (isDragging) {
                isDragging = false;
                launchCourse(ev.clientX, ev.clientY);
            }
        });

        svg.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (!isDragging) {
                launchCourse(ev.clientX, ev.clientY);
            }
            isDragging = false;
        });

        // ESC to close
        const onEsc = (e) => {
            if (e.key === 'Escape') { hideRadar(); document.removeEventListener('keydown', onEsc); }
        };
        document.addEventListener('keydown', onEsc);
    }

    function hideRadar() {
        if (_radarEl) { _radarEl.remove(); _radarEl = null; }
        unlockMap();
    }

    // ─────────────────────────────────────────────────────────────────────
    // TOAST
    // ─────────────────────────────────────────────────────────────────────
    function toast(msg, type = 'info') {
        document.querySelectorAll('.sim-toast').forEach(t => t.remove());
        const t = document.createElement('div');
        t.className = `sim-toast sim-toast-${type}`;
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.classList.add('sim-toast-show'), 10);
        setTimeout(() => { t.classList.remove('sim-toast-show'); setTimeout(() => t.remove(), 400); }, 3200);
    }

    // ─────────────────────────────────────────────────────────────────────
    // PLACE SHIP
    // ─────────────────────────────────────────────────────────────────────
    function enterPlacingMode() {
        _placingMode = true;
        _map.getContainer().style.cursor = 'crosshair';
        const btn = document.getElementById('simAddBtn');
        if (btn) { btn.classList.add('sim-btn-placing'); btn.textContent = '🎯 Click Ocean to Place Ship'; }
        toast('Click anywhere on the ocean to place your simulation ship.', 'info');
    }

    function exitPlacingMode() {
        _placingMode = false;
        _map.getContainer().style.cursor = '';
        const btn = document.getElementById('simAddBtn');
        if (btn) { btn.classList.remove('sim-btn-placing'); btn.textContent = '➕ Add Simulation Ship'; }
    }

    function confirmReplace(onYes) {
        document.getElementById('simReplaceDialog')?.remove();
        const dlg = document.createElement('div');
        dlg.id = 'simReplaceDialog';
        dlg.innerHTML = `
          <div class="sim-modal-backdrop"></div>
          <div class="sim-confirm-box">
            <div class="sim-confirm-icon">⚠️</div>
            <p class="sim-confirm-msg">A Simulation Ship already exists.<br>
               <strong>Replace existing Simulation Ship?</strong></p>
            <div class="sim-confirm-actions">
              <button class="sim-btn-cancel" id="simReplaceNo">NO</button>
              <button class="sim-btn-danger"  id="simReplaceYes">YES, Replace</button>
            </div>
          </div>`;
        document.body.appendChild(dlg);
        document.getElementById('simReplaceYes').addEventListener('click', () => { dlg.remove(); onYes(); });
        document.getElementById('simReplaceNo').addEventListener('click', () => { dlg.remove(); exitPlacingMode(); });
        dlg.querySelector('.sim-modal-backdrop').addEventListener('click', () => { dlg.remove(); exitPlacingMode(); });
    }

    function showPropertiesModal(lat, lon, onSave) {
        document.getElementById('simModal')?.remove();
        const modal = document.createElement('div');
        modal.id = 'simModal';
        modal.innerHTML = `
          <div class="sim-modal-backdrop" id="simBackdrop"></div>
          <div class="sim-modal-box" role="dialog" aria-modal="true">
            <div class="sim-modal-header">
              <span class="sim-modal-icon">🚢</span>
              <h2 class="sim-modal-title">Configure Simulation Ship</h2>
            </div>
            <div class="sim-modal-coords">📍 ${lat.toFixed(5)}, ${lon.toFixed(5)}</div>
            <div class="sim-modal-body">
              <div class="sim-field">
                <label for="simName">Ship Name</label>
                <input id="simName" type="text" value="SAMPLE SHIP" maxlength="40"/>
              </div>
              <div class="sim-field-row">
                <div class="sim-field">
                  <label for="simSpeed">Speed (Knots)</label>
                  <input id="simSpeed" type="number" value="12" min="1" max="60" step="0.5"/>
                </div>
                <div class="sim-field">
                  <label for="simFuel">Fuel (%)</label>
                  <input id="simFuel" type="number" value="80" min="0" max="100"/>
                </div>
              </div>
              <div class="sim-field">
                <label for="simDest">Destination (Optional)</label>
                <input id="simDest" type="text" maxlength="60" placeholder="e.g. Port of Singapore"/>
              </div>
            </div>
            <div class="sim-modal-footer">
              <button class="sim-btn-cancel" id="simCancel">Cancel</button>
              <button class="sim-btn-save"   id="simSave">Place Ship</button>
            </div>
          </div>`;
        document.body.appendChild(modal);
        setTimeout(() => document.getElementById('simName')?.select(), 50);
        document.getElementById('simSave').addEventListener('click', () => {
            const name = document.getElementById('simName').value.trim() || 'SAMPLE SHIP';
            const speed = parseFloat(document.getElementById('simSpeed').value) || 12;
            const fuel = Math.min(100, Math.max(0, parseInt(document.getElementById('simFuel').value) || 80));
            const dest = document.getElementById('simDest').value.trim();
            modal.remove();
            onSave({ name, speed, fuel, destination: dest });
        });
        document.getElementById('simCancel').addEventListener('click', () => modal.remove());
        document.getElementById('simBackdrop').addEventListener('click', () => modal.remove());
        modal.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('simSave').click(); });
    }

    function buildSimPopupHTML(ship) {
        if (!ship) return '';
        const latStr = ship.lat.toFixed(5);
        const lonStr = ship.lon.toFixed(5);
        const headingStr = Math.round(ship.heading || 0) + '°';
        const speedStr = (ship.speed || 12) + ' kn';
        const statusText = ship.moving ? 'Underway / Moving' : 'Idle / Anchored';
        const statusClass = ship.moving ? 'color:#10b981;' : 'color:#f59e0b;';
        const fuel = ship.fuel !== undefined ? ship.fuel : 80;

        return `
            <div class="maritime-popup" style="font-family:'Inter', sans-serif; min-width: 230px; padding:4px;">
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #e2e8f0; padding-bottom:6px; margin-bottom:8px;">
                    <strong style="color:#0f172a; font-size:13px;">🚢 ${ship.name || 'SIMULATION SHIP'}</strong>
                    <span id="simPopupStatus" style="font-size:10px; font-weight:700; ${statusClass}">${statusText}</span>
                </div>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px; font-size:11px; margin-bottom:8px;">
                    <div style="background:#f8fafc; padding:6px; border-radius:6px;">
                        <div style="color:#64748b; font-size:10px;">Latitude</div>
                        <strong id="simPopupLat" style="color:#0f172a; font-family:'JetBrains Mono', monospace;">${latStr}</strong>
                    </div>
                    <div style="background:#f8fafc; padding:6px; border-radius:6px;">
                        <div style="color:#64748b; font-size:10px;">Longitude</div>
                        <strong id="simPopupLon" style="color:#0f172a; font-family:'JetBrains Mono', monospace;">${lonStr}</strong>
                    </div>
                    <div style="background:#f8fafc; padding:6px; border-radius:6px;">
                        <div style="color:#64748b; font-size:10px;">Speed</div>
                        <strong id="simPopupSpeed" style="color:#0f172a;">${speedStr}</strong>
                    </div>
                    <div style="background:#f8fafc; padding:6px; border-radius:6px;">
                        <div style="color:#64748b; font-size:10px;">Heading</div>
                        <strong id="simPopupHeading" style="color:#0f172a;">${headingStr}</strong>
                    </div>
                </div>

                <div style="margin-bottom:8px; background:#f8fafc; padding:6px; border-radius:6px;">
                    <div style="display:flex; justify-content:space-between; font-size:10px; color:#64748b; margin-bottom:3px;">
                        <span>⛽ Fuel Level</span>
                        <strong id="simPopupFuelVal" style="color:#0f172a;">${fuel}%</strong>
                    </div>
                    <div style="width:100%; background:#e2e8f0; height:6px; border-radius:3px; overflow:hidden;">
                        <div id="simPopupFuelBar" style="width:${fuel}%; background:linear-gradient(90deg, #10b981, #34d399); height:100%;"></div>
                    </div>
                </div>

                <div style="font-size:10px; color:#64748b; margin-bottom:8px;">
                    <strong>Destination:</strong> ${ship.destination || 'Open Ocean'}
                </div>

                <div style="display:flex; flex-direction:column; gap:6px;">
                    <button id="triggerEmergencyRoute" style="
                        width: 100%;
                        background: linear-gradient(135deg, #ef4444, #dc2626);
                        color: white;
                        border: none;
                        padding: 7px 10px;
                        border-radius: 6px;
                        font-weight: 700;
                        font-size: 11px;
                        cursor: pointer;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        gap: 6px;
                    ">🚨 TRIGGER EMERGENCY ROUTE</button>

                    <button id="stopSimShip" style="
                        width: 100%;
                        background: #475569;
                        color: white;
                        border: none;
                        padding: 6px 10px;
                        border-radius: 6px;
                        font-weight: 700;
                        font-size: 11px;
                        cursor: pointer;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        gap: 6px;
                    ">🛑 STOP SHIP</button>
                </div>
                <div style="margin-top:6px; font-size:9px; color:#94a3b8; text-align:center;">
                    (Double-click ship to open Radar Navigation)
                </div>
            </div>
        `;
    }

    let _coordEngineFrame = null;

    /** Continuous 60FPS coordinate engine: guarantees coordinates NEVER stop updating */
    function startContinuousCoordinateEngine() {
        if (_coordEngineFrame) cancelAnimationFrame(_coordEngineFrame);

        function coordTick() {
            if (_marker && _ship) {
                const ll = _marker.getLatLng();
                if (ll && ll.lat !== undefined && ll.lng !== undefined) {
                    const lat = ll.lat;
                    const lon = ll.lng;

                    _ship.lat = lat;
                    _ship.lon = lon;
                    _ship.lng = lon;

                    // 1. Top-right map inspect panel
                    const latEl = document.getElementById('latValue');
                    const lngEl = document.getElementById('lngValue');
                    if (latEl) latEl.textContent = lat.toFixed(6);
                    if (lngEl) lngEl.textContent = lon.toFixed(6);

                    // 2. Right-side Digital Twin panel
                    const dtCoords = document.getElementById('dtShipCoords');
                    if (dtCoords) dtCoords.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

                    // 3. Single-click vessel popup
                    const popLat = document.getElementById('simPopupLat');
                    const popLon = document.getElementById('simPopupLon');
                    if (popLat) popLat.textContent = lat.toFixed(5);
                    if (popLon) popLon.textContent = lon.toFixed(5);

                    // 4. Global currentMission
                    if (window.currentMission?.current?.ship) {
                        window.currentMission.current.ship.lat = lat;
                        window.currentMission.current.ship.lon = lon;
                        window.currentMission.current.ship.lng = lon;
                    }
                }
            }
            _coordEngineFrame = requestAnimationFrame(coordTick);
        }

        _coordEngineFrame = requestAnimationFrame(coordTick);
    }

    function placeShip(lat, lon, props) {
        if (_marker) { stopMovement(); _map.removeLayer(_marker); _marker = null; }
        window.emergencyCache = null; // Clear old emergency cache on new ship placement

        _ship = {
            name: props.name, lat, lon,
            speed: props.speed, fuel: props.fuel,
            destination: props.destination || '',
            heading: 0, distanceTravelled: 0,
            targetLat: null, targetLon: null, moving: false
        };

        _marker = L.marker([lat, lon], {
            icon: createSimIcon(0),
            title: _ship.name + ' — Drag to set course, Double-click Radar',
            draggable: true,
            zIndexOffset: 9000,
            interactive: true
        });

        startContinuousCoordinateEngine();

        // Direct marker drag interaction: draw dynamic directional path arrow
        _marker.on('dragstart', () => {
            stopMovement();
            _dragStart = { lat: _ship.lat, lon: _ship.lon };
        });

        _marker.on('drag', (e) => {
            if (!_ship || !_dragStart) return;
            const currentLL = e.target.getLatLng();
            const bearing = calcBearing(_dragStart.lat, _dragStart.lon, currentLL.lat, currentLL.lng);
            _ship.heading = bearing;
            _marker.setIcon(createSimIcon(bearing));

            const dest = destinationPoint(_dragStart.lat, _dragStart.lon, bearing, MOVE_DISTANCE_KM);
            renderPathArrow(_dragStart.lat, _dragStart.lon, dest.lat, dest.lon, bearing);
        });

        _marker.on('dragend', (e) => {
            if (!_ship || !_dragStart) return;
            const currentLL = e.target.getLatLng();
            const bearing = calcBearing(_dragStart.lat, _dragStart.lon, currentLL.lat, currentLL.lng);
            const distKm = haversineKm(_dragStart.lat, _dragStart.lon, currentLL.lat, currentLL.lng);

            if (distKm >= 1) {
                const dest = destinationPoint(currentLL.lat, currentLL.lng, bearing, MOVE_DISTANCE_KM);
                _ship.lat = currentLL.lat;
                _ship.lon = currentLL.lng;
                _ship.heading = bearing;
                toast(`Course set via drag: ${Math.round(bearing)}° — launching ship`, 'success');
                startMovement(dest.lat, dest.lon);
            } else {
                _ship.lat = currentLL.lat;
                _ship.lon = currentLL.lng;
                _updateCBs.forEach(fn => fn({ ..._ship }));
                clearPathArrow();
            }
        });

        // Single click -> open live telemetry popup
        _marker.bindPopup(() => buildSimPopupHTML(_ship), { maxWidth: 260 });

        _marker.on('popupopen', (e) => {
            const popup = e.popup ? e.popup.getElement() : null;
            if (!popup) return;
            const emergencyBtn = popup.querySelector("#triggerEmergencyRoute");
            if (emergencyBtn) {
                emergencyBtn.addEventListener("click", async () => {
                    console.log("🚨 Emergency button clicked");
                    const marker = window.SimulationShip?.getMarker();
                    const vessel = window.SimulationShip?.getData();
                    if (!vessel) {
                        console.error("Simulation ship not found");
                        return;
                    }
                    stopMovement();
                    if (window.MissionEngine) {
                        window.MissionEngine.startMission(vessel);
                    }
                    if (window.TimeSim) {
                        window.TimeSim.showPanel();
                        window.TimeSim.showLoading();
                    }
                    if (window.MaritimeRoute) {
                        await window.MaritimeRoute.triggerEmergencyResponse(marker, vessel);
                    }
                });
            }

            const stopBtn = popup.querySelector("#stopSimShip");
            if (stopBtn) {
                stopBtn.addEventListener("click", () => {
                    stopMovement();
                    if (window.MaritimeAnimation) window.MaritimeAnimation.stopAnimation();
                });
            }
        });

        const openRadarHandler = (e) => {
            if (e) {
                if (e.stopPropagation) e.stopPropagation();
                if (e.preventDefault) e.preventDefault();
                if (L.DomEvent && L.DomEvent.stopPropagation) L.DomEvent.stopPropagation(e);
            }
            if (_radarEl) { hideRadar(); return; }
            _marker.closePopup();
            showRadar();
        };

        // Double click on ship → open radar
        _marker.on('dblclick', openRadarHandler);

        _marker.addTo(_map);

        // Bind direct DOM event on icon element for double click
        setTimeout(() => {
            const el = _marker.getElement();
            if (el) {
                el.style.cursor = 'pointer';
                el.addEventListener('dblclick', openRadarHandler, true);
            }
        }, 50);

        _updateCBs.forEach(fn => fn({ ..._ship }));
    }

    // ─────────────────────────────────────────────────────────────────────
    // SMOOTH MOVEMENT ANIMATION
    // ─────────────────────────────────────────────────────────────────────
    function startMovement(targetLat, targetLon) {
        if (!_ship) return;
        stopMovement();

        _ship.targetLat = targetLat;
        _ship.targetLon = targetLon;
        _ship.moving = true;
        _ship.heading = calcBearing(_ship.lat, _ship.lon, targetLat, targetLon);

        _marker.setIcon(createSimIcon(_ship.heading));
        _marker.getElement()?.classList.add('sim-moving');

        const startLat = _ship.lat;
        const startLon = _ship.lon;
        const totalDist = haversineKm(startLat, startLon, targetLat, targetLon);
        const kmPerMs = (_ship.speed * 1.852) / 3_600_000;

        renderPathArrow(startLat, startLon, targetLat, targetLon, _ship.heading);

        let elapsed = 0;
        let lastTime = null;

        function step(ts) {
            if (!_ship || !_ship.moving) return;
            if (!lastTime) lastTime = ts;
            const dt = ts - lastTime;
            lastTime = ts;
            elapsed += dt;

            const moved = elapsed * kmPerMs;
            const ratio = Math.min(moved / totalDist, 1.0);

            _ship.lat = startLat + (targetLat - startLat) * ratio;
            _ship.lon = startLon + (targetLon - startLon) * ratio;
            _ship.distanceTravelled += kmPerMs * dt;

            _marker.setLatLng([_ship.lat, _ship.lon]);
            renderPathArrow(_ship.lat, _ship.lon, targetLat, targetLon, _ship.heading);

            // Update floating coordinate display live
            const latEl = document.getElementById('latValue');
            const lngEl = document.getElementById('lngValue');
            if (latEl) latEl.textContent = _ship.lat.toFixed(6);
            if (lngEl) lngEl.textContent = _ship.lon.toFixed(6);

            // Update open single-click vessel popup elements live if visible
            const popLat = document.getElementById('simPopupLat');
            const popLon = document.getElementById('simPopupLon');
            const popHeading = document.getElementById('simPopupHeading');
            const popSpeed = document.getElementById('simPopupSpeed');
            const popStatus = document.getElementById('simPopupStatus');

            if (popLat) popLat.textContent = _ship.lat.toFixed(5);
            if (popLon) popLon.textContent = _ship.lon.toFixed(5);
            if (popHeading) popHeading.textContent = Math.round(_ship.heading || 0) + '°';
            if (popSpeed) popSpeed.textContent = (_ship.speed || 12) + ' kn';
            if (popStatus) {
                popStatus.textContent = 'Underway / Moving';
                popStatus.style.color = '#10b981';
            }

            if (ratio >= 1.0) {
                _ship.lat = targetLat; _ship.lon = targetLon;
                _ship.moving = false;
                _marker.getElement()?.classList.remove('sim-moving');
                _updateCBs.forEach(fn => fn({ ..._ship }));
                clearPathArrow();
                toast(`${_ship.name} arrived at destination.`, 'success');
                return;
            }
            _animFrame = requestAnimationFrame(step);
        }

        _animFrame = requestAnimationFrame(step);
    }

    function stopMovement() {
        if (_animFrame) { cancelAnimationFrame(_animFrame); _animFrame = null; }
        if (_ship) {
            _ship.moving = false;
        }
        _marker?.getElement()?.classList.remove('sim-moving');
        clearPathArrow();
    }

    // ─────────────────────────────────────────────────────────────────────
    // SET SIM POSITION (called by Digital Twin time slider)
    // Silently repositions the marker without triggering animations or CBs
    // ─────────────────────────────────────────────────────────────────────
    function setSimPosition(lat, lon, heading) {
        if (!_marker) return;
        if (_ship) {
            _ship.lat = lat;
            _ship.lon = lon;
            _ship.lng = lon;
            if (heading !== undefined && heading !== null) _ship.heading = heading;
        }

        // 1. Move Leaflet marker on map
        _marker.setLatLng([lat, lon]);

        // 2. Rotate rotator element in-place without destroying DOM node
        if (heading !== undefined && heading !== null) {
            const el = _marker.getElement();
            if (el) {
                const rotator = el.querySelector('.sim-rotator, .ship-rotator, .standalone-ship-wrapper, svg');
                if (rotator) {
                    rotator.style.transform = `rotate(${Math.round(heading)}deg)`;
                }
            }
        }

        // 3. Update floating coordinate display
        const latEl = document.getElementById('latValue');
        const lngEl = document.getElementById('lngValue');
        if (latEl) latEl.textContent = lat.toFixed(6);
        if (lngEl) lngEl.textContent = lon.toFixed(6);

        // 4. Update Digital Twin right panel coordinate display if present
        const dtCoords = document.getElementById('dtShipCoords');
        if (dtCoords) dtCoords.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

        // 5. Update popup coordinate display if open
        const popLat = document.getElementById('simPopupLat');
        const popLon = document.getElementById('simPopupLon');
        const popHeading = document.getElementById('simPopupHeading');
        const popSpeed = document.getElementById('simPopupSpeed');
        const popStatus = document.getElementById('simPopupStatus');

        if (popLat) popLat.textContent = lat.toFixed(5);
        if (popLon) popLon.textContent = lon.toFixed(5);
        if (popHeading && heading !== undefined) popHeading.textContent = Math.round(heading) + '°';
        if (popSpeed && _ship?.speed) popSpeed.textContent = (_ship.speed || 12) + ' kn';
        if (popStatus) {
            popStatus.textContent = 'Underway / Moving';
            popStatus.style.color = '#10b981';
        }
    }

    function setSimFuel(fuelPct) {
        if (_ship) {
            _ship.fuel = Math.min(100, Math.max(0, parseFloat(fuelPct.toFixed(1))));
            const popupFuelVal = document.getElementById('simPopupFuelVal');
            const popupFuelBar = document.getElementById('simPopupFuelBar');
            if (popupFuelVal) popupFuelVal.textContent = `${_ship.fuel}%`;
            if (popupFuelBar) popupFuelBar.style.width = `${_ship.fuel}%`;
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // DIRECTIONAL PATH ARROW & SEGMENT MARKER
    // ─────────────────────────────────────────────────────────────────────
    let _pathArrowMarker = null;
    let _pathSegmentLine = null;

    function renderPathArrow(curLat, curLon, nextLat, nextLon, heading) {
        if (!_map) return;

        // 1. Draw dashed vector segment line from ship position to next waypoint
        if (_pathSegmentLine) {
            _pathSegmentLine.setLatLngs([[curLat, curLon], [nextLat, nextLon]]);
        } else {
            _pathSegmentLine = L.polyline([[curLat, curLon], [nextLat, nextLon]], {
                color: '#38bdf8',
                weight: 3,
                dashArray: '6, 6',
                opacity: 0.85,
                zIndexOffset: 1000
            }).addTo(_map);
        }

        // 2. Draw rotating directional mark arrow icon along the segment
        const rot = (typeof heading === 'number' && !isNaN(heading)) ? Math.round(heading) : 0;
        const arrowIcon = L.divIcon({
            className: 'path-direction-mark-icon',
            html: `<div style="transform: rotate(${rot}deg); display:flex; align-items:center; justify-content:center; filter: drop-shadow(0 2px 6px rgba(0,0,0,0.5));">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                    <path d="M12 2L19 21L12 17L5 21L12 2Z" fill="#10b981" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/>
                </svg>
            </div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14]
        });

        // Position directional arrow halfway along the current segment for clear visibility
        const midLat = curLat + (nextLat - curLat) * 0.45;
        const midLon = curLon + (nextLon - curLon) * 0.45;

        if (_pathArrowMarker) {
            _pathArrowMarker.setLatLng([midLat, midLon]);
            _pathArrowMarker.setIcon(arrowIcon);
        } else {
            _pathArrowMarker = L.marker([midLat, midLon], {
                icon: arrowIcon,
                interactive: false,
                zIndexOffset: 2000
            }).addTo(_map);
        }
    }

    function clearPathArrow() {
        if (_pathArrowMarker && _map) {
            _map.removeLayer(_pathArrowMarker);
            _pathArrowMarker = null;
        }
        if (_pathSegmentLine && _map) {
            _map.removeLayer(_pathSegmentLine);
            _pathSegmentLine = null;
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // ADD BUTTON
    // ─────────────────────────────────────────────────────────────────────
    function createAddButton() {
        let btn = document.getElementById('simAddBtn');
        if (!btn) {
            if (!document.body) return;
            btn = document.createElement('button');
            btn.id = 'simAddBtn';
            btn.className = 'sim-add-btn';
            btn.textContent = '➕ Add Simulation Ship';
            btn.title = 'Place a simulation ship anywhere on the map';
            document.body.appendChild(btn);
        }

        if (!btn.dataset.bound) {
            btn.dataset.bound = 'true';
            btn.addEventListener('click', (e) => {
                if (e) e.stopPropagation();
                if (_placingMode) {
                    exitPlacingMode();
                } else {
                    enterPlacingMode();
                }
            });
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // MAP CLICK (placement)
    // ─────────────────────────────────────────────────────────────────────
    function onMapClick(e) {
        if (!_placingMode) return;
        const { lat, lng } = e.latlng;
        exitPlacingMode();
        showPropertiesModal(lat, lng, (props) => {
            placeShip(lat, lng, props);
            toast(`${props.name} placed. Double-click ship to open Radar Navigation.`, 'success');
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // PUBLIC API
    // ─────────────────────────────────────────────────────────────────────
    function getData() { return _ship ? { ..._ship } : null; }
    function getMarker() { return _marker; }
    function exists() { return _ship !== null; }
    function onUpdate(fn) { if (typeof fn === 'function') _updateCBs.push(fn); }

    function init(mapInstance) {
        _map = mapInstance || window.MaritimeMap?.getMap();
        if (!_map) { console.error('SimulationShip: no map'); return; }
        createAddButton();
        _map.on('click', onMapClick);
    }

    const publicApi = { init, getData, getMarker, exists, onUpdate, stopMovement, setSimPosition, setSimFuel, renderPathArrow, clearPathArrow };
    if (typeof window !== 'undefined') window.SimulationShip = publicApi;

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', createAddButton);
        } else {
            createAddButton();
        }
    }

    return publicApi;

})();
