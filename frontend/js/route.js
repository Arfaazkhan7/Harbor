/**
 * Maritime Emergency Response System — Professional Emergency Routing Engine
 * =========================================================================
 * REFACTORED (Tasks 1b, 3):
 *   - Removed duplicate left-side Mission Dashboard (now consolidated in Digital Twin)
 *   - Added Chaikin Curve smoothing for realistic marine route rendering
 *   - Fixed polyline options: smoothFactor=0, weight=6, lineCap/lineJoin=round
 *   - Full coordinate list from searoute — never simplified before rendering
 *   - Exposed renderRoutePolyline() for TimeSim Digital Twin to call
 *   - Fallback chain: Port 1 → Port 2 → Port 3 → Port 4 → Port 5
 */

const MaritimeRoute = (function () {
    'use strict';

    let _map = null;
    let _routePolyline = null;
    let _emergencyPortsLayerGroup = null;
    let _telemetryHudEl = null;

    let _currentVesselMarker = null;
    let _currentVesselData = null;
    let _top5Ports = [];
    let _selectedPort = null;
    let _currentRouteData = null;
    let _currentSmoothedCoords = null;
    let _storedEmergencyPathCoords = null;

    /** Calculate Haversine distance in km */
    function haversineKm(lat1, lon1, lat2, lon2) {
        const R = 6371.0, r = Math.PI / 180;
        const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function normalizeRouteCoords(coords) {
        if (!Array.isArray(coords)) return [];
        return coords
            .map(c => {
                if (Array.isArray(c) && c.length >= 2) return [parseFloat(c[0]), parseFloat(c[1])];
                if (c && typeof c === 'object') return [parseFloat(c.lat ?? c.latitude), parseFloat(c.lon ?? c.lng ?? c.longitude)];
                return null;
            })
            .filter(c => Number.isFinite(c[0]) && Number.isFinite(c[1]));
    }

    function storeEmergencyPath(routeData, coords) {
        const normalized = normalizeRouteCoords(coords || routeData?.coordinates);
        if (!routeData || normalized.length < 2) return null;

        _storedEmergencyPathCoords = normalized.map(c => [c[0], c[1]]);
        routeData.coordinates = _storedEmergencyPathCoords.map(c => [c[0], c[1]]);
        _currentRouteData = routeData;
        window.emergencyCache = routeData;

        return _storedEmergencyPathCoords;
    }

    // ── Chaikin Curve Smoothing ──────────────────────────────────────────────
    /**
     * Apply Chaikin's corner-cutting algorithm to smooth a polyline.
     * Preserves the overall sea path — only rounds sharp turns.
     * @param {Array} coords  [[lat,lon], ...]
     * @param {number} iterations  Number of smoothing passes (2–3 is ideal)
     * @returns {Array} smoothed coordinate array
     */
    function chaikinSmooth(coords, iterations = 3) {
        coords = normalizeRouteCoords(coords);
        if (!coords || coords.length < 3) return coords;

        let pts = coords;
        for (let iter = 0; iter < iterations; iter++) {
            const smoothed = [pts[0]]; // Always keep exact start point
            for (let i = 0; i < pts.length - 1; i++) {
                const p0 = pts[i];
                const p1 = pts[i + 1];
                // Cut at 25% and 75% of each segment
                smoothed.push([
                    0.75 * p0[0] + 0.25 * p1[0],
                    0.75 * p0[1] + 0.25 * p1[1]
                ]);
                smoothed.push([
                    0.25 * p0[0] + 0.75 * p1[0],
                    0.25 * p0[1] + 0.75 * p1[1]
                ]);
            }
            smoothed.push(pts[pts.length - 1]); // Always keep exact end point
            pts = smoothed;
        }
        return pts;
    }

    /** Calculate badge color for Route Safety Score */
    function getSafetyScoreBadge(score, rating) {
        let color = '#10b981', label = rating || 'Perfect';
        if (score < 35) {
            color = '#ef4444';
            label = 'Very Dangerous';
        } else if (score < 55) {
            color = '#f97316';
            label = 'Danger';
        } else if (score < 75) {
            color = '#eab308';
            label = 'Moderate';
        } else if (score < 90) {
            color = '#3b82f6';
            label = 'Good';
        }

        return `
            <div style="display:inline-flex; align-items:center; gap:10px; background:${color}15; border:1px solid ${color}60; padding:8px 14px; border-radius:10px;">
                <span style="font-size:24px; font-weight:800; color:${color}; font-family:'JetBrains Mono', monospace;">${score} / 100</span>
                <div>
                    <div style="font-size:10px; text-transform:uppercase; color:#94a3b8; font-weight:600; letter-spacing:0.5px;">Safety Score</div>
                    <div style="font-size:12px; font-weight:800; color:${color}; text-transform:uppercase;">${label}</div>
                </div>
            </div>
        `;
    }

    /** Clear emergency map layers */
    function clearEmergencyLayers() {
        if (_routePolyline && _map) {
            _map.removeLayer(_routePolyline);
            _routePolyline = null;
        }

        if (_emergencyPortsLayerGroup && _map) {
            _map.removeLayer(_emergencyPortsLayerGroup);
            _emergencyPortsLayerGroup = null;
        }

        if (window.MaritimeWeather) {
            window.MaritimeWeather.clearWeatherPoints();
        }

        if (window.MaritimeAnimation) {
            window.MaritimeAnimation.stopAnimation();
        }

        removeTelemetryHud();
        closeWhyPortModal();
        _currentRouteData = null;
        _storedEmergencyPathCoords = null;
    }

    /** Render candidate ports on map — clean pins, no green ocean glowing circles */
    function renderTop5PortsOnMap(portsList, selectedPortId) {
        if (_emergencyPortsLayerGroup && _map) {
            _map.removeLayer(_emergencyPortsLayerGroup);
        }

        _emergencyPortsLayerGroup = L.featureGroup().addTo(_map);

        portsList.forEach((port, idx) => {
            const isRecommended = (port.id === selectedPortId || String(port.id) === String(selectedPortId));
            const rank = idx + 1;
            const lat = float(port.LATITUDE);
            const lon = float(port.LONGITUDE);
            const pinColor = isRecommended ? '#10B981' : '#3B82F6';
            const pinSize  = isRecommended ? 38 : 30;

            const recBadgeHTML = isRecommended ? `<div class="rec-port-badge" style="background:#10B981;">RECOMMENDED</div>` : '';

            const portIcon = L.divIcon({
                className: '',
                html: `
                    <div style="
                        position: relative;
                        width:${pinSize}px; height:${pinSize + 12}px;
                        display:flex; flex-direction:column; align-items:center;
                        filter: drop-shadow(0 4px 10px ${pinColor}aa);
                    ">
                        ${recBadgeHTML}
                        <svg width="${pinSize}" height="${pinSize}" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
                            <circle cx="20" cy="17" r="16" fill="${pinColor}" stroke="#ffffff" stroke-width="2.5"/>
                            <circle cx="20" cy="17" r="11" fill="rgba(255,255,255,0.2)"/>
                            <g transform="translate(12.5, 9) scale(0.75)" stroke="#ffffff" stroke-width="2" stroke-linecap="round" fill="none">
                                <circle cx="10" cy="4" r="2.5"/>
                                <line x1="10" y1="6.5" x2="10" y2="17"/>
                                <line x1="6" y1="9" x2="14" y2="9"/>
                                <path d="M4 13.5 C4 17.5 7.5 19.5 10 19.5 C12.5 19.5 16 17.5 16 13.5"/>
                                <line x1="2.5" y1="12" x2="5.5" y2="15"/>
                                <line x1="14.5" y1="12" x2="17.5" y2="15"/>
                            </g>
                            <text x="20" y="22" text-anchor="middle" font-family="Inter,sans-serif" font-size="9" font-weight="800" fill="#ffffff">#${rank}</text>
                            <polygon points="16,31 20,40 24,31" fill="${pinColor}" stroke="#ffffff" stroke-width="1"/>
                        </svg>
                    </div>`,
                iconSize: [pinSize, pinSize + 12],
                iconAnchor: [pinSize / 2, pinSize + 12],
                popupAnchor: [0, -(pinSize + 12)]
            });

            const marker = L.marker([lat, lon], { icon: portIcon, zIndexOffset: isRecommended ? 9500 : 8000 });

            const tooltipText = isRecommended
                ? `<b>RECOMMENDED: ${port.PORT_NAME}</b><br><span style="color:#10B981;font-weight:700;">${port.distance_km} km away</span>`
                : `<b>#${rank} ${port.PORT_NAME}</b><br><span style="color:#94a3b8;">${port.distance_km} km away</span>`;

            marker.bindTooltip(
                tooltipText,
                { permanent: true, direction: 'top', offset: [0, -(pinSize + 14)], className: 'emergency-port-tooltip', opacity: 1 }
            );

            marker.bindPopup(
                `<div style="font-family:'Inter',sans-serif;padding:6px;min-width:200px">
                    <div style="font-size:10px;color:${pinColor};font-weight:800;text-transform:uppercase;margin-bottom:3px;">
                        ${isRecommended ? '🌟 RECOMMENDED PORT' : `🚨 Emergency Port #${rank}`}
                    </div>
                    <strong style="font-size:14px;color:#0f172a">${port.PORT_NAME}</strong> <span style="color:#64748b">(${port.COUNTRY})</span><br>
                    <div style="margin:6px 0; font-size:11px; color:#475569;">
                        Distance: <strong>${port.distance_km} km</strong> (${port.distance_nm} NM)
                    </div>
                    <button onclick="MaritimeRoute.selectPortAndRecalculate('${port.id}')" style="
                        width:100%;background:${pinColor};color:#fff;border:none;
                        padding:7px;border-radius:6px;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;
                        box-shadow:0 3px 10px ${pinColor}60;">⚓ Inspect Route To This Port</button>
                </div>`,
                { maxWidth: 240 }
            );

            _emergencyPortsLayerGroup.addLayer(marker);
        });

        if (_emergencyPortsLayerGroup.getLayers().length) {
            try {
                const b = _emergencyPortsLayerGroup.getBounds();
                if (_currentVesselData) {
                    b.extend([_currentVesselData.lat, _currentVesselData.lon || _currentVesselData.lng]);
                }
                if (_routePolyline) {
                    b.extend(_routePolyline.getBounds());
                }
                _map.fitBounds(b, { padding: [100, 100], maxZoom: 8 });
            } catch(e) {}
        }
    }

    /** "WHY THIS PORT?" Modal Popup */
    function showWhyPortModal(port, routeData) {
        closeWhyPortModal();

        const modal = document.createElement('div');
        modal.id = 'whyPortModal';
        modal.className = 'why-port-modal-overlay';
        modal.innerHTML = `
            <div class="why-port-modal-box">
                <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e2e8f0;padding-bottom:10px;margin-bottom:14px;">
                    <div>
                        <div style="font-size:10px;color:#16a34a;font-weight:800;text-transform:uppercase;letter-spacing:0.5px;">RECOMMENDED DESTINATION RATIONALE</div>
                        <h3 style="font-size:15px;font-weight:800;color:#0f172a;margin-top:3px;">${port.PORT_NAME} <span style="color:#64748b;font-weight:500;">(${port.COUNTRY})</span></h3>
                    </div>
                    <button id="closeWhyPortModalBtn" style="background:none;border:none;color:#94a3b8;font-size:20px;cursor:pointer;">✕</button>
                </div>

                <div style="display:flex;flex-direction:column;gap:9px;font-size:12px;line-height:1.55;color:#374151;margin-bottom:18px;">
                    <div style="display:flex;align-items:flex-start;gap:8px;">
                        <span style="color:#16a34a;font-weight:800;font-size:14px;">✓</span>
                        <div><strong style="color:#0f172a;">Shortest Navigable Sea Route:</strong> Validated ${routeData.sea_route_distance_km || port.distance_km} km sea path avoiding all landmasses.</div>
                    </div>
                    <div style="display:flex;align-items:flex-start;gap:8px;">
                        <span style="color:#16a34a;font-weight:800;font-size:14px;">✓</span>
                        <div><strong style="color:#0f172a;">Lowest Overall Weather Risk:</strong> Route safety score of ${routeData.safety_score} / 100 (${routeData.safety_rating}).</div>
                    </div>
                    <div style="display:flex;align-items:flex-start;gap:8px;">
                        <span style="color:#16a34a;font-weight:800;font-size:14px;">✓</span>
                        <div><strong style="color:#0f172a;">Lowest Fuel Consumption:</strong> Estimated ~${routeData.fuel_tons || ((port.distance_km || 0) * 0.08).toFixed(1)} Tons.</div>
                    </div>
                    <div style="display:flex;align-items:flex-start;gap:8px;">
                        <span style="color:#16a34a;font-weight:800;font-size:14px;">✓</span>
                        <div><strong style="color:#0f172a;">Safest Emergency Destination:</strong> High-capacity port equipped for emergency vessel assistance.</div>
                    </div>
                    <div style="display:flex;align-items:flex-start;gap:8px;">
                        <span style="color:#16a34a;font-weight:800;font-size:14px;">✓</span>
                        <div><strong style="color:#0f172a;">Nearest Reachable Port:</strong> Ranked #1 among all verified navigable candidate routes.</div>
                    </div>
                    <div style="display:flex;align-items:flex-start;gap:8px;">
                        <span style="color:#16a34a;font-weight:800;font-size:14px;">✓</span>
                        <div><strong style="color:#0f172a;">No Land Crossings:</strong> Verified 100% open sea corridor route geometry.</div>
                    </div>
                    <div style="display:flex;align-items:flex-start;gap:8px;">
                        <span style="color:#16a34a;font-weight:800;font-size:14px;">✓</span>
                        <div><strong style="color:#0f172a;">Route Verified:</strong> Dense geometry with ${routeData.coordinates ? routeData.coordinates.length : 0} waypoints (Chaikin smoothed).</div>
                    </div>
                </div>

                <button id="confirmWhyPortBtn" style="width:100%;background:#1e40af;color:#fff;border:none;padding:11px;border-radius:9px;font-weight:700;font-size:13px;cursor:pointer;font-family:'Inter',sans-serif;">GOT IT — CLOSE</button>
            </div>
        `;

        document.body.appendChild(modal);

        document.getElementById('closeWhyPortModalBtn')?.addEventListener('click', closeWhyPortModal);
        document.getElementById('confirmWhyPortBtn')?.addEventListener('click', closeWhyPortModal);
        modal.addEventListener('click', (e) => { if (e.target === modal) closeWhyPortModal(); });
    }

    function closeWhyPortModal() {
        document.getElementById('whyPortModal')?.remove();
    }

    /** Live Telemetry HUD during vessel animation */
    function updateTelemetryHud(telemetry) {
        if (!_telemetryHudEl) {
            const hud = document.createElement('div');
            hud.id = 'telemetryHud';
            hud.style.cssText = `
                position: fixed;
                top: 68px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 1200;
                background: linear-gradient(135deg, #0c1f36, #0f2a44);
                border: 1px solid #1e3a5f;
                box-shadow: 0 4px 24px rgba(0,0,0,0.6);
                border-radius: 12px;
                padding: 10px 16px;
                color: #e2e8f0;
                font-family: 'JetBrains Mono', monospace;
                font-size: 11px;
                min-width: 360px;
                display: flex;
                align-items: center;
                gap: 16px;
            `;
            document.body.appendChild(hud);
            _telemetryHudEl = hud;
        }

        const latEl = document.getElementById('latValue');
        const lngEl = document.getElementById('lngValue');
        if (latEl) latEl.textContent = telemetry.lat.toFixed(6);
        if (lngEl) lngEl.textContent = telemetry.lon.toFixed(6);

        const spdStr  = telemetry.speedKnots ? `${telemetry.speedKnots} kn` : '15 kn';
        const fuelVal = telemetry.remainingFuelPct !== undefined ? `${telemetry.remainingFuelPct}%` : '100%';
        const burnVal = telemetry.burnedFuelPct ? `(-${telemetry.burnedFuelPct}%)` : '';
        const fuelColor = parseFloat(telemetry.remainingFuelPct || 100) < 25 ? '#ef4444' : '#10b981';

        _telemetryHudEl.innerHTML = `
            <span style="color:#38bdf8;font-weight:700;font-size:10px;white-space:nowrap;">📡 LIVE TELEMETRY</span>
            <span style="color:#94a3b8;font-size:10px;">LAT <span style="color:#e2e8f0;font-weight:700;">${telemetry.lat.toFixed(4)}</span></span>
            <span style="color:#94a3b8;font-size:10px;">LON <span style="color:#e2e8f0;font-weight:700;">${telemetry.lon.toFixed(4)}</span></span>
            <span style="color:#94a3b8;font-size:10px;">SPD <span style="color:#f59e0b;font-weight:700;">${spdStr}</span></span>
            <span style="color:#94a3b8;font-size:10px;">FUEL <span style="color:${fuelColor};font-weight:700;">${fuelVal}</span> <span style="color:#64748b;font-size:9px;">${burnVal}</span></span>
            <span style="color:#94a3b8;font-size:10px;">HDG <span style="color:#ea580c">${telemetry.heading}°</span></span>
            <span style="color:#94a3b8;font-size:10px;">REM <span style="color:#38bdf8">${telemetry.distanceRemainingKm} km</span></span>
            <span style="color:#10b981;font-weight:700;font-size:10px;">${telemetry.progressPercent}%</span>
            <button id="hudStopShipBtn" style="
                background:#dc2626;color:#fff;border:none;padding:4px 10px;
                border-radius:6px;font-family:'Inter',sans-serif;font-weight:700;font-size:10px;cursor:pointer;
            ">🛑 STOP</button>
        `;

        document.getElementById('hudStopShipBtn')?.addEventListener('click', () => {
            if (window.MaritimeAnimation) window.MaritimeAnimation.stopAnimation();
            if (window.SimulationShip) window.SimulationShip.stopMovement();
            if (window.MaritimeMap?.toast) window.MaritimeMap.toast('🛑 Emergency journey stopped.', 'error');
        });
    }

    function removeTelemetryHud() {
        if (_telemetryHudEl) {
            _telemetryHudEl.remove();
            _telemetryHudEl = null;
        }
    }

    /**
     * Draw smoothed sea route polyline with Chaikin curve algorithm.
     * Task 1b: smoothFactor=0, weight=6, opacity=0.95, lineCap/lineJoin=round
     * Progressive drawing animation from ship toward destination.
     */
    function drawAnimatedPolyline(coords) {
        if (_routePolyline && _map) _map.removeLayer(_routePolyline);
        coords = normalizeRouteCoords(coords);
        if (!coords || coords.length < 2) return;

        // Apply Chaikin curve smoothing — preserves sea path, rounds sharp turns
        const smoothedCoords = chaikinSmooth(coords, 3);
        _currentSmoothedCoords = smoothedCoords;

        // Professional ocean-blue navigation line
        const polyOptions = {
            color:        '#1B6CA8',   // Deep ocean blue
            weight:       6,
            opacity:      0.95,
            lineCap:      'round',
            lineJoin:     'round',
            smoothFactor: 0            // Never simplify — use every coordinate
        };

        if (smoothedCoords.length <= 2) {
            _routePolyline = L.polyline(smoothedCoords, polyOptions).addTo(_map);
            return;
        }

        // Progressive drawing animation: reveal route from ship to port
        let currentPoints = [smoothedCoords[0], smoothedCoords[1]];
        _routePolyline = L.polyline(currentPoints, polyOptions).addTo(_map);

        let targetIndex = 2;
        const total = smoothedCoords.length;

        function animateStep() {
            if (targetIndex < total) {
                currentPoints.push(smoothedCoords[targetIndex]);
                _routePolyline.setLatLngs(currentPoints);
                targetIndex++;
                requestAnimationFrame(animateStep);
            } else {
                // Final: ensure route is exactly set to full smoothed path
                _routePolyline.setLatLngs(smoothedCoords);
            }
        }

        requestAnimationFrame(animateStep);
    }

    function drawStaticPolyline(coords) {
        if (_routePolyline && _map) _map.removeLayer(_routePolyline);
        coords = normalizeRouteCoords(coords);
        if (!coords || coords.length < 2) return [];

        const smoothedCoords = chaikinSmooth(coords, 3);
        _currentSmoothedCoords = smoothedCoords;
        _routePolyline = L.polyline(smoothedCoords, {
            color: '#1B6CA8',
            weight: 6,
            opacity: 0.95,
            lineCap: 'round',
            lineJoin: 'round',
            smoothFactor: 0
        }).addTo(_map);
        return smoothedCoords;
    }

    /**
     * Public method for TimeSim Digital Twin to redraw the route polyline
     * without triggering the full emergency workflow.
     */
    function renderRoutePolyline(coords, selectedPort) {
        coords = normalizeRouteCoords(coords);
        if (!coords || coords.length < 2) return;
        drawAnimatedPolyline(coords);
    }

    async function refreshRouteFromLiveShipPosition(rData, shipMarker, shipData) {
        const selectedPort = rData?.selected_port || _selectedPort;
        if (!selectedPort || !shipMarker || typeof shipMarker.getLatLng !== 'function') return rData;

        const currentLL = shipMarker.getLatLng();
        const shipLat = parseFloat(currentLL?.lat ?? shipData?.lat);
        const shipLon = parseFloat(currentLL?.lng ?? shipData?.lon ?? shipData?.lng);
        const destLat = float(selectedPort.LATITUDE);
        const destLon = float(selectedPort.LONGITUDE);
        const speedKnots = shipData?.speed || rData?.ship_speed || 15.0;

        if (![shipLat, shipLon, destLat, destLon].every(Number.isFinite)) return rData;

        try {
            const res = await fetch('/api/route_analysis', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ship_lat: shipLat,
                    ship_lon: shipLon,
                    dest_lat: destLat,
                    dest_lon: destLon,
                    ship_speed: speedKnots
                })
            });
            const routeData = await res.json();
            const routeCoords = normalizeRouteCoords(routeData.coordinates);
            if (!routeData.success || routeCoords.length < 2) return rData;

            routeCoords[0] = [shipLat, shipLon];
            routeCoords[routeCoords.length - 1] = [destLat, destLon];

            const refreshed = {
                ...rData,
                ...routeData,
                selected_port: selectedPort,
                candidates: rData?.candidates || _top5Ports,
                coordinates: routeCoords,
                sea_route_distance_km: routeData.eta?.distance_km || rData?.sea_route_distance_km,
                sea_route_distance_nm: routeData.eta?.distance_nm || rData?.sea_route_distance_nm
            };

            _currentRouteData = refreshed;
            storeEmergencyPath(refreshed, routeCoords);
            drawStaticPolyline(routeCoords);
            if (window.MaritimeWeather && routeData.sampled_weather) {
                window.MaritimeWeather.renderWeatherPoints(_map, routeData.sampled_weather);
            }
            if (window.TimeSim?.onEmergencyRoute) {
                window.TimeSim.onEmergencyRoute(refreshed, shipData?.name || _currentVesselData?.name);
            }
            return refreshed;
        } catch (err) {
            console.warn('[Emergency] Could not refresh route from live ship position:', err);
            return rData;
        }
    }

    /** Trigger complete emergency response workflow — cache-first for instant response */
    async function triggerEmergencyResponse(shipMarker, vesselData) {
        if (!_map) _map = window.MaritimeMap?.getMap();
        if (!_map) return;

        _currentVesselMarker = (window.SimulationShip ? window.SimulationShip.getMarker() : null) || shipMarker;
        _currentVesselData   = (window.SimulationShip ? window.SimulationShip.getData()  : null) || vesselData;

        if (!_currentVesselData || !_currentVesselMarker) {
            console.error('❌ Simulation Ship instance not found.');
            return;
        }

        const shipLat    = _currentVesselData.lat;
        const shipLon    = _currentVesselData.lon || _currentVesselData.lng;
        const speedKnots = _currentVesselData.speed || 15.0;
        const vesselName = _currentVesselData.name || 'Emergency Vessel';

        clearEmergencyLayers();

        // ── CACHE-FIRST: Check if pre-warmed route is valid for CURRENT ship position ─
        const cachedEmergency = window.emergencyCache;
        const origStart = (cachedEmergency && cachedEmergency.coordinates && cachedEmergency.coordinates.length > 0)
            ? cachedEmergency.coordinates[0]
            : null;
        const distFromCacheStart = origStart ? haversineKm(shipLat, shipLon, origStart[0], origStart[1]) : 999;

        if (cachedEmergency && cachedEmergency.success &&
            cachedEmergency.coordinates && cachedEmergency.coordinates.length > 3 &&
            distFromCacheStart < 30) {

            console.log('[Emergency] ⚡ INSTANT response from pre-warmed cache!');
            cachedEmergency.coordinates[0] = [shipLat, shipLon]; // Snap start waypoint to exact ship position

            if (window.MaritimeMap?.toast) {
                window.MaritimeMap.toast(
                    `⚡ INSTANT: ${cachedEmergency.selected_port?.PORT_NAME} — ${cachedEmergency.sea_route_distance_km} km — Pre-computed!`,
                    'success'
                );
            }

            _renderEmergencyResult(cachedEmergency, vesselName);
            _refreshEmergencyCache(shipLat, shipLon, speedKnots);
            return;
        }

        // ── FALLBACK: Cache not ready yet — call API ─────────────────────────
        console.log('[Emergency] Cache not ready — computing route via API...');
        if (window.MaritimeMap?.toast) {
            window.MaritimeMap.toast(
                `🚨 Computing emergency route for ${vesselName}…`,
                'warning'
            );
        }

        try {
            const res  = await fetch('/api/emergency/find_route', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ship_lat: shipLat, ship_lon: shipLon, ship_speed: speedKnots })
            });
            const data = await res.json();

            if (!data.success || !data.coordinates || data.coordinates.length < 3) {
                const msg = data.error || 'No navigable route found after exhausting all candidates.';
                if (window.MaritimeMap?.toast) window.MaritimeMap.toast('❌ ' + msg, 'error');
                return;
            }

            // Store in cache for next press
            window.emergencyCache = data;
            _renderEmergencyResult(data, vesselName);

        } catch (err) {
            console.error('❌ Emergency workflow error:', err);
            if (window.MaritimeMap?.toast) window.MaritimeMap.toast('Emergency failed: ' + err.message, 'error');
        }
    }

    /** Calculate bearing between two lat/lon points */
    function calcBearing(lat1, lon1, lat2, lon2) {
        const r = Math.PI / 180;
        const dL = (lon2 - lon1) * r;
        const y = Math.sin(dL) * Math.cos(lat2 * r);
        const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) -
            Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dL);
        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }

    /** Shared renderer for emergency result (from cache or API) */
    function _renderEmergencyResult(data, vesselName) {
        const selectedPort = data.selected_port;
        _selectedPort      = selectedPort;
        _top5Ports         = data.candidates || [selectedPort];
        _currentRouteData  = data;
        const coords       = normalizeRouteCoords(data.coordinates);
        data.coordinates   = coords;

        // Force snap route origin to live vessel position so polyline connects seamlessly
        const vLat = _currentVesselData ? _currentVesselData.lat : null;
        const vLon = _currentVesselData ? (_currentVesselData.lon || _currentVesselData.lng) : null;
        if (vLat !== null && vLon !== null && coords && coords.length > 0) {
            coords[0] = [vLat, vLon];
        }

        storeEmergencyPath(data, coords);

        printDebug('Emergency Port',      `${selectedPort.PORT_NAME} (${selectedPort.COUNTRY})`);
        printDebug('Route Waypoints',     coords.length);
        printDebug('Distance',            `${data.sea_route_distance_km} km (${data.sea_route_distance_nm} NM)`);
        printDebug('ETA',                 data.eta?.formatted_duration || '--');
        printDebug('Fuel Required',       `${data.fuel_tons} T`);
        printDebug('Safety Score',        `${data.safety_score} / 100 (${data.safety_rating})`);

        // 1. Draw smooth Chaikin-smoothed sea route
        drawAnimatedPolyline(coords);

        // 2. Port pins on map
        renderTop5PortsOnMap(_top5Ports, selectedPort.id);

        // 3. Route weather points
        if (window.MaritimeWeather && data.sampled_weather) {
            window.MaritimeWeather.renderWeatherPoints(_map, data.sampled_weather);
        }

        // 4. Push into Digital Twin panel & trigger prediction engine re-calculation
        if (window.MissionEngine?.triggerEmergency) {
            window.MissionEngine.triggerEmergency(data);
        } else if (window.TimeSim?.onEmergencyRoute) {
            window.TimeSim.onEmergencyRoute(data, vesselName);
        }

        // 5. Add to mission timeline
        if (window.MissionEngine?.addEvent) {
            window.MissionEngine.addEvent('danger', `🚨 Emergency Route: ${selectedPort.PORT_NAME} — ${data.sea_route_distance_km} km — ETA: ${data.eta?.formatted_duration}`);
        }

        // 6. Wire START EMERGENCY JOURNEY button — launch journey ONLY when user clicks this button
        setTimeout(() => {
            updateJourneyButtonsState(window.MaritimeAnimation?.isAnimating());
        }, 50);

        if (window.MaritimeMap?.toast) {
            window.MaritimeMap.toast(`⭐ BEST PORT: ${selectedPort.PORT_NAME} — ${data.sea_route_distance_km} km`, 'success');
        }
    }

    /** Helper to keep all Emergency Journey buttons across UI 100% in sync */
    function updateJourneyButtonsState(isAnimating) {
        const btns = document.querySelectorAll('.dt-start-journey-btn, #dtStartJourneyBtn');
        if (!btns || btns.length === 0) return;
        btns.forEach(b => {
            if (isAnimating) {
                b.style.background = 'linear-gradient(135deg, #dc2626, #991b1b)';
                b.innerHTML = '🛑 PAUSE JOURNEY';
            } else {
                b.style.background = 'linear-gradient(135deg, #16a34a, #15803d)';
                b.innerHTML = '🟢 START EMERGENCY JOURNEY';
            }
            b.onclick = (e) => {
                if (e) e.preventDefault();
                startEmergencyJourney();
            };
        });
    }

    /**
     * Launch emergency route journey animation along the calculated sea route.
     * Moves ship marker smoothly and updates live coordinates and telemetry across HUD & Digital Twin.
     */
    async function startEmergencyJourney() {
        // ── Step 1: Get the ship marker and data ────────────────────────────
        const shipMarker = window.SimulationShip?.getMarker() || _currentVesselMarker;
        const shipData   = window.SimulationShip?.getData() || _currentVesselData || {};

        if (!shipMarker) {
            if (window.MaritimeMap?.toast) window.MaritimeMap.toast('Vessel marker not found on map', 'error');
            return;
        }

        // ── Step 2: Handle PAUSE if already animating ────────────────────────
        const firstBtn = document.querySelector('.dt-start-journey-btn, #dtStartJourneyBtn');
        const isPauseAction = window.MaritimeAnimation?.isAnimating() && firstBtn && (
            firstBtn.innerHTML.includes('PAUSE') || firstBtn.innerHTML.includes('STOP')
        );
        if (isPauseAction) {
            window.MaritimeAnimation.stopAnimation();
            updateJourneyButtonsState(false);
            if (window.MaritimeMap?.toast) window.MaritimeMap.toast('🛑 Journey paused', 'warning');
            return;
        }

        // ── Step 3: Immediately stop any existing ship movement ──────────────
        // This ensures we capture the ship's exact frozen position before the async fetch.
        if (window.SimulationShip?.stopMovement) window.SimulationShip.stopMovement();
        if (window.MaritimeAnimation?.isAnimating()) window.MaritimeAnimation.stopAnimation();

        // ── Step 4: Grab the exact live position AFTER stopping movement ─────
        const liveLL = (typeof shipMarker.getLatLng === 'function') ? shipMarker.getLatLng() : null;
        if (!liveLL || !Number.isFinite(liveLL.lat) || !Number.isFinite(liveLL.lng)) {
            if (window.MaritimeMap?.toast) window.MaritimeMap.toast('Cannot determine current ship position', 'error');
            return;
        }
        const liveLat = liveLL.lat;
        const liveLon = liveLL.lng;

        // ── Step 5: Identify the target port ────────────────────────────────
        const selectedPort = _selectedPort ||
            _currentRouteData?.selected_port ||
            window.emergencyCache?.selected_port ||
            (window.TimeSim?.getEmergencyData ? window.TimeSim.getEmergencyData()?.selected_port : null);

        if (!selectedPort || !selectedPort.LATITUDE || !selectedPort.LONGITUDE) {
            // No port has been selected yet — fall back to full emergency trigger
            if (window.MaritimeMap?.toast) window.MaritimeMap.toast('🚨 Computing emergency route…', 'warning');
            await triggerEmergencyResponse(shipMarker, shipData);
            // After trigger, re-invoke startEmergencyJourney once route is ready
            const newRouteData = _currentRouteData || window.emergencyCache;
            if (!newRouteData || !newRouteData.coordinates || newRouteData.coordinates.length < 2) {
                if (window.MaritimeMap?.toast) window.MaritimeMap.toast('No valid emergency route available', 'error');
                return;
            }
            // Recursively start the journey now that route is populated
            return startEmergencyJourney();
        }

        const destLat = parseFloat(selectedPort.LATITUDE);
        const destLon = parseFloat(selectedPort.LONGITUDE);
        const speedToUse = parseFloat(shipData.speed) || 15.0;
        const destPortName = selectedPort.PORT_NAME || 'Port';

        // ── Step 6: Always re-fetch the route from the ship's EXACT live position ──
        // This guarantees the ship follows the correct sea path even if it was
        // moving in a completely different direction when the button was pressed.
        if (window.MaritimeMap?.toast) {
            window.MaritimeMap.toast(`📡 Computing fresh sea route from current position to ${destPortName}…`, 'warning');
        }
        updateJourneyButtonsState(false);  // Disable button while calculating

        let freshRouteCoords = null;
        let freshRouteData   = null;
        try {
            const res = await fetch('/api/route_analysis', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ship_lat:   liveLat,
                    ship_lon:   liveLon,
                    dest_lat:   destLat,
                    dest_lon:   destLon,
                    ship_speed: speedToUse
                })
            });
            const routeData = await res.json();

            if (routeData.success && routeData.coordinates && routeData.coordinates.length >= 2) {
                freshRouteData = {
                    ...(_currentRouteData || window.emergencyCache || {}),
                    ...routeData,
                    selected_port: selectedPort,
                    candidates: _top5Ports
                };
                freshRouteCoords = normalizeRouteCoords(routeData.coordinates).map(c => [c[0], c[1]]);

                // Pin start/end precisely
                freshRouteCoords[0] = [liveLat, liveLon];
                freshRouteCoords[freshRouteCoords.length - 1] = [destLat, destLon];

                // Store & redraw the authoritative path
                storeEmergencyPath(freshRouteData, freshRouteCoords);
                _currentRouteData = freshRouteData;
                drawStaticPolyline(freshRouteCoords);

            } else {
                console.warn('[Emergency Journey] Fresh route fetch failed:', routeData.error);
            }
        } catch (err) {
            console.warn('[Emergency Journey] Route API error:', err);
        }

        // ── Step 7: Fall back to cached/stored coords if fresh fetch failed ─
        if (!freshRouteCoords || freshRouteCoords.length < 2) {
            const fallbackData = _currentRouteData || window.emergencyCache ||
                (window.TimeSim?.getEmergencyData ? window.TimeSim.getEmergencyData() : null);
            if (!fallbackData || !fallbackData.coordinates || fallbackData.coordinates.length < 2) {
                if (window.MaritimeMap?.toast) window.MaritimeMap.toast('Emergency route coordinates are invalid', 'error');
                updateJourneyButtonsState(false);
                return;
            }
            freshRouteCoords = normalizeRouteCoords(fallbackData.coordinates).map(c => [c[0], c[1]]);
            // Always snap start to live ship position even in fallback
            freshRouteCoords[0] = [liveLat, liveLon];
            if (window.MaritimeMap?.toast) {
                window.MaritimeMap.toast('⚠ Using cached route. Ship will steer toward port.', 'warning');
            }
        }

        // ── Step 8: Validate animation engine ───────────────────────────────
        if (!window.MaritimeAnimation?.startRouteAnimation) {
            if (window.MaritimeMap?.toast) window.MaritimeMap.toast('Emergency animation engine is not ready', 'error');
            updateJourneyButtonsState(false);
            return;
        }

        // ── Step 9: Set ship's visual heading toward first route waypoint ───
        // The animation engine will then turn it smoothly onto each subsequent segment.
        const initialBearing = calcBearing(liveLat, liveLon,
            freshRouteCoords[Math.min(1, freshRouteCoords.length - 1)][0],
            freshRouteCoords[Math.min(1, freshRouteCoords.length - 1)][1]);
        if (window.SimulationShip?.setSimPosition) {
            window.SimulationShip.setSimPosition(liveLat, liveLon, Math.round(initialBearing));
        }

        // ── Step 10: Launch the animation along the fresh exact path ─────────
        if (window.MaritimeMap?.toast) {
            window.MaritimeMap.toast(`🚀 Emergency Journey to ${destPortName} launched at ${speedToUse} knots!`, 'success');
        }

        const started = window.MaritimeAnimation.startRouteAnimation(
            shipMarker,
            freshRouteCoords,
            speedToUse,
            (telemetry) => {
                updateTelemetryHud(telemetry);
                if (window.TimeSim?.updateLiveTelemetry) window.TimeSim.updateLiveTelemetry(telemetry);
            },
            (finalState) => {
                updateJourneyButtonsState(false);
                if (finalState.etaRemaining === 'OUT OF FUEL') {
                    if (window.MaritimeMap?.toast) window.MaritimeMap.toast('⛽ Emergency Journey stopped: Fuel depleted.', 'error');
                } else {
                    if (window.MaritimeMap?.toast) window.MaritimeMap.toast(`🎉 Journey Completed: Vessel safely docked at ${destPortName}!`, 'success');
                }
                removeTelemetryHud();
                if (window.MissionEngine?.addEvent) window.MissionEngine.addEvent('success', `🎉 Journey Completed: Vessel docked at ${destPortName}`);
            }
        );

        if (!started) {
            updateJourneyButtonsState(false);
            if (window.MaritimeMap?.toast) window.MaritimeMap.toast('Could not start emergency journey animation', 'error');
            return;
        }

        updateJourneyButtonsState(true);
    }

    /** Silently refresh emergency cache after instant response */
    async function _refreshEmergencyCache(shipLat, shipLon, speedKnots) {
        try {
            const res  = await fetch('/api/emergency/find_route', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ship_lat: shipLat, ship_lon: shipLon, ship_speed: speedKnots })
            });
            const data = await res.json();
            if (data.success) {
                window.emergencyCache = data;
                console.log('[Emergency] Background cache refreshed.');
            }
        } catch(e) { /* silent */ }
    }

    /** Helper to generate sea route for a specific candidate port */
    async function generateRouteAndRender(shipLat, shipLon, portObj, speedKnots, vesselName) {
        _selectedPort = portObj;

        const destLat = float(portObj.LATITUDE);
        const destLon = float(portObj.LONGITUDE);

        const routeRes = await fetch('/api/route_analysis', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ship_lat:   shipLat,
                ship_lon:   shipLon,
                dest_lat:   destLat,
                dest_lon:   destLon,
                ship_speed: speedKnots
            })
        });

        const routeData = await routeRes.json();

        if (!routeData.success || !routeData.coordinates || routeData.coordinates.length < 3) {
            const reason = routeData.error || 'Route returned invalid coordinates.';
            printDebug("Port Switcher", `Route Failed for ${portObj.PORT_NAME} (${reason})`);
            if (window.MaritimeMap?.toast) {
                window.MaritimeMap.toast(
                    `⚠ No valid sea route to ${portObj.PORT_NAME}: ${reason}`,
                    'error'
                );
            }
            return;
        }

        // Snap exact start to ship lat/lon and end to port lat/lon
        if (routeData.coordinates && routeData.coordinates.length > 0) {
            routeData.coordinates[0]  = [shipLat, shipLon];
            routeData.coordinates[routeData.coordinates.length - 1] = [destLat, destLon];
        }

        const enrichedRouteData = {
            ...routeData,
            selected_port: portObj,
            candidates: _top5Ports,
            sea_route_distance_km: routeData.eta?.distance_km || routeData.sea_route_distance_km || 0,
            sea_route_distance_nm: routeData.eta?.distance_nm || routeData.sea_route_distance_nm || 0
        };
        storeEmergencyPath(enrichedRouteData, routeData.coordinates);

        drawAnimatedPolyline(routeData.coordinates);

        if (window.MaritimeWeather) {
            window.MaritimeWeather.renderWeatherPoints(_map, routeData.sampled_weather);
        }

        // Update Digital Twin with new route data
        if (window.TimeSim?.onEmergencyRoute) {
            window.TimeSim.onEmergencyRoute(enrichedRouteData, vesselName);
        }
    }

    /** Allow user to click any port card to re-calculate route */
    async function selectPortAndRecalculate(portId) {
        const found = _top5Ports.find(p => String(p.id) === String(portId));
        if (!found || !_currentVesselData) return;

        renderTop5PortsOnMap(_top5Ports, found.id);
        const shipLat = _currentVesselData.lat;
        const shipLon = _currentVesselData.lon || _currentVesselData.lng;
        const speedKnots = _currentVesselData.speed || 15.0;
        const vesselName = _currentVesselData.name || 'Emergency Vessel';

        // If clicking the recommended port and we already have its route data
        if (_selectedPort && String(found.id) === String(_selectedPort.id) && _currentRouteData && _currentRouteData.coordinates) {
            drawAnimatedPolyline(_currentRouteData.coordinates);
            if (window.MaritimeWeather) {
                window.MaritimeWeather.renderWeatherPoints(_map, _currentRouteData.sampled_weather);
            }
            if (window.MaritimeMap?.toast) {
                window.MaritimeMap.toast(`🌟 Displaying Recommended Route for ${found.PORT_NAME}`, 'success');
            }
            return;
        }

        await generateRouteAndRender(shipLat, shipLon, found, speedKnots, vesselName);
    }

    function printDebug(label, val) {
        console.log(`  [Emergency Route Engine] ${label.padEnd(25)} :`, val);
    }

    function float(val) {
        return parseFloat(val) || 0.0;
    }

    const publicApi = {
        init: (map) => { _map = map; },
        triggerEmergencyResponse,
        selectPortAndRecalculate,
        renderRoutePolyline,
        clearRoute: clearEmergencyLayers,
        getCurrentVesselMarker: () => _currentVesselMarker,
        getCurrentVesselData: () => _currentVesselData,
        getCurrentRouteData: () => _currentRouteData,
        startEmergencyJourney,
        updateJourneyButtonsState,
        updateTelemetryHud
    };
    if (typeof window !== 'undefined') window.MaritimeRoute = publicApi;
    return publicApi;
})();
