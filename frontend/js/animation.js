/**
 * Maritime Emergency Response System — Route Animation Module
 * ==========================================================
 * Animates ship marker smoothly along actual sea route coordinates returned by searoute.
 * Updates live telemetry HUD: Lat, Lon, Heading, Distance Remaining, ETA.
 */

const MaritimeAnimation = (function () {
    'use strict';

    let _map = null;
    let _animFrame = null;
    let _isAnimating = false;
    let _onUpdateCallbacks = [];
    let _onCompleteCallbacks = [];

    /** Calculate bearing between two lat/lon points */
    function calcBearing(lat1, lon1, lat2, lon2) {
        const r = Math.PI / 180;
        const dL = (lon2 - lon1) * r;
        const y = Math.sin(dL) * Math.cos(lat2 * r);
        const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) -
            Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dL);
        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }

    /** Calculate Haversine distance in km */
    function haversineKm(lat1, lon1, lat2, lon2) {
        const R = 6371.0, r = Math.PI / 180;
        const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /** Normalize any heading to the marine compass range 0..359.999 */
    function normalizeHeading(deg) {
        return ((deg % 360) + 360) % 360;
    }

    /** Normalize heading delta to -180..+180 so the rudder chooses the shortest turn */
    function shortestHeadingDelta(targetHeading, currentHeading) {
        return ((targetHeading - currentHeading + 540) % 360) - 180;
    }

    /** Interpolate along a route segment while staying locked to the displayed sea path */
    function interpolateSegment(p1, p2, ratio) {
        return [
            p1[0] + (p2[0] - p1[0]) * ratio,
            p1[1] + (p2[1] - p1[1]) * ratio
        ];
    }

    /** Start smooth vessel animation along searoute coordinate array */
    function startRouteAnimation(marker, routeCoordinates, speedKnots, onTick, onComplete) {
        stopAnimation();

        if (!marker || !routeCoordinates || routeCoordinates.length < 2) {
            console.warn("MaritimeAnimation: Invalid parameters for animation");
            return false;
        }

        const animCoords = routeCoordinates
            .map(c => [parseFloat(c[0]), parseFloat(c[1])])
            .filter(c => Number.isFinite(c[0]) && Number.isFinite(c[1]));

        if (animCoords.length < 2) {
            console.warn("MaritimeAnimation: Route coordinates are not numeric");
            return false;
        }

        // Snap origin coordinate to live marker position
        if (marker && typeof marker.getLatLng === 'function') {
            const mll = marker.getLatLng();
            if (mll && mll.lat !== undefined && mll.lng !== undefined && animCoords.length > 0) {
                animCoords[0] = [mll.lat, mll.lng];
            }
        }

        // Calculate total distance along all coordinate segments
        let cumulativeDistances = [0.0];
        let totalDistKm = 0.0;
        for (let i = 1; i < animCoords.length; i++) {
            const p1 = animCoords[i - 1];
            const p2 = animCoords[i];
            const segDist = haversineKm(p1[0], p1[1], p2[0], p2[1]);
            if (!Number.isFinite(segDist)) {
                console.warn("MaritimeAnimation: Invalid segment distance", { p1, p2 });
                return false;
            }
            totalDistKm += segDist;
            cumulativeDistances[i] = totalDistKm;
        }

        if (!Number.isFinite(totalDistKm) || totalDistKm < 0.05) {
            console.warn("MaritimeAnimation: Route is too short to animate", { totalDistKm, animCoords });
            return false;
        }

        _isAnimating = true;

        // Speed in knots and simulation speed calculation
        const validSpeedKnots = parseFloat(speedKnots) || window.SimulationShip?.getData()?.speed || 15.0;
        const speedKmh = validSpeedKnots * 1.852;
        // Smooth continuous voyage duration: 12 to 45 seconds voyage animation depending on route distance
        const targetDurationMs = totalDistKm > 0 ? Math.max(12000, Math.min(45000, totalDistKm * 30)) : 12000;
        const kmPerMs = totalDistKm > 0 ? (totalDistKm / targetDurationMs) : 0.0005;

        // Dynamic fuel burn rate (% fuel burned per km) scaling with knots speed (hydrodynamic drag)
        const startingFuel = window.SimulationShip?.getData()?.fuel ?? 80;
        const fuelBurnRatePerKm = 0.006 * (1.0 + Math.max(0, validSpeedKnots - 15.0) * 0.03);

        let lastTimestamp = null;
        let currentSegIndex = 0;
        let currentSegProgressKm = 0;
        let distanceCovered = 0;

        const steeringConfig = {
            maxTurnDegPerFrame: 15.0,      // Turn up to 15° per frame — quickly snaps ship onto emergency route heading
            waypointArrivalRadiusKm: 0.08,
            minForwardFactor: 0.3          // Allow slower forward movement during sharp turns to stay on path
        };

        // ALWAYS initialize heading from the first route segment bearing.
        // This ensures the ship immediately faces the correct direction toward the port,
        // regardless of whatever direction it was moving before the emergency journey started.
        const initialRouteBearing = calcBearing(
            animCoords[0][0], animCoords[0][1],
            animCoords[Math.min(1, animCoords.length - 1)][0],
            animCoords[Math.min(1, animCoords.length - 1)][1]
        );

        // Prefer the simulated ship's heading if it has already been set to route bearing by route.js (Step 9).
        // Fall back to the computed initial route bearing so the ship never starts facing the wrong way.
        const storedHeading = window.SimulationShip?.getData()?.heading;
        let currentHeading = (storedHeading !== undefined && !isNaN(storedHeading))
            ? parseFloat(storedHeading)
            : initialRouteBearing;

        // Immediately update the ship's stored heading and icon rotation so there is no visual lag
        // between pressing the button and the ship turning toward the emergency port.
        if (window.SimulationShip?.setSimPosition) {
            const startPos = animCoords[0];
            window.SimulationShip.setSimPosition(startPos[0], startPos[1], Math.round(initialRouteBearing));
        }
        const iconEl0 = marker.getElement();
        if (iconEl0) {
            const rotator0 = iconEl0.querySelector('.sim-rotator') || iconEl0.querySelector('.ship-rotator') || iconEl0.querySelector('svg');
            if (rotator0) rotator0.style.transform = `rotate(${Math.round(initialRouteBearing)}deg)`;
        }
        // Update currentHeading to match the route bearing so we don't lose time turning
        currentHeading = initialRouteBearing;

        console.log('[MaritimeAnimation] 🚀 Starting Emergency Journey Animation', {
            'routeCoordinates.length': animCoords.length,
            'routeCoordinates': animCoords,
            'totalDistance': totalDistKm
        });

        function animateStep(timestamp) {
            if (!_isAnimating) return;

            if (!lastTimestamp) lastTimestamp = timestamp;
            const deltaMs = timestamp - lastTimestamp;
            lastTimestamp = timestamp;

            const stepDistanceKm = Math.max(0, deltaMs * kmPerMs);

            // Dynamic fuel burn based on distance traveled and knot speed
            const burnedFuelPct = Math.min(startingFuel, distanceCovered * fuelBurnRatePerKm);
            const remainingFuelPct = Math.max(0, startingFuel - burnedFuelPct);

            // Sync live fuel state into SimulationShip instance
            if (window.SimulationShip?.setSimFuel) {
                window.SimulationShip.setSimFuel(remainingFuelPct);
            }

            if (currentSegIndex >= animCoords.length - 1 || distanceCovered >= totalDistKm) {
                // Reached destination port — keep coordinates locked at destination live
                const lastCoord = animCoords[animCoords.length - 1];
                marker.setLatLng(lastCoord);
                if (window.SimulationShip?.setSimPosition) {
                    window.SimulationShip.setSimPosition(lastCoord[0], lastCoord[1], Math.round(currentHeading));
                }
                if (window.SimulationShip?.clearPathArrow) {
                    window.SimulationShip.clearPathArrow();
                }

                const finalState = {
                    lat: lastCoord[0],
                    lon: lastCoord[1],
                    lng: lastCoord[1],
                    latitude: lastCoord[0],
                    longitude: lastCoord[1],
                    heading: Math.round(currentHeading),
                    speedKnots: validSpeedKnots.toFixed(1),
                    remainingFuelPct: remainingFuelPct.toFixed(1),
                    burnedFuelPct: burnedFuelPct.toFixed(1),
                    distanceRemainingKm: (0.0).toFixed(1),
                    distanceRemainingNm: (0.0).toFixed(1),
                    etaRemaining: "Journey Completed",
                    progressPercent: 100
                };

                console.log('[MaritimeAnimation] 🏁 Journey Completed', {
                    'routeCoordinates.length': animCoords.length,
                    'routeCoordinates': animCoords,
                    'totalDistance': totalDistKm,
                    'currentSegmentIndex': animCoords.length - 1,
                    'distanceCovered': totalDistKm,
                    'interpolatedLatitude': lastCoord[0],
                    'interpolatedLongitude': lastCoord[1],
                    'animationProgress': '100%',
                    'requestAnimationFrame ID': _animFrame
                });

                if (typeof onTick === 'function') onTick(finalState);
                if (typeof onComplete === 'function') onComplete(finalState);
                _isAnimating = false;
                return;
            }

            const p1 = animCoords[currentSegIndex];
            const p2 = animCoords[Math.min(currentSegIndex + 1, animCoords.length - 1)];
            const segLength = Math.max(0, cumulativeDistances[currentSegIndex + 1] - cumulativeDistances[currentSegIndex]);
            const currentRatio = segLength > 0 ? currentSegProgressKm / segLength : 0;
            const currentPos = interpolateSegment(p1, p2, currentRatio);

            // 1. Target only the next waypoint in the emergency route.
            const targetBearing = calcBearing(currentPos[0], currentPos[1], p2[0], p2[1]);

            // 2. Normalize the desired-vs-current heading error to -180..+180 degrees.
            const angleDiff = shortestHeadingDelta(targetBearing, currentHeading);

            // 3. Turn left or right by the shortest angular distance, capped by rudder speed.
            const turnStep = Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), steeringConfig.maxTurnDegPerFrame);
            currentHeading = normalizeHeading(currentHeading + turnStep);

            // 4. Keep forward motion and rotation simultaneous, reducing progress while still lining up.
            const postTurnDiff = shortestHeadingDelta(targetBearing, currentHeading);
            const alignmentFactor = Math.max(steeringConfig.minForwardFactor, Math.cos(Math.abs(postTurnDiff) * Math.PI / 180));
            let remainingStepKm = stepDistanceKm * alignmentFactor;

            // 5. Advance waypoint-by-waypoint and switch targets inside the configurable arrival radius.
            while (remainingStepKm > 0 && currentSegIndex < animCoords.length - 1) {
                const activeSegLength = Math.max(0, cumulativeDistances[currentSegIndex + 1] - cumulativeDistances[currentSegIndex]);
                const remainingOnSegmentKm = Math.max(0, activeSegLength - currentSegProgressKm);

                if (remainingOnSegmentKm <= steeringConfig.waypointArrivalRadiusKm || remainingStepKm >= remainingOnSegmentKm) {
                    distanceCovered = Math.min(totalDistKm, distanceCovered + remainingOnSegmentKm);
                    remainingStepKm -= remainingOnSegmentKm;
                    currentSegIndex++;
                    currentSegProgressKm = 0;
                } else {
                    currentSegProgressKm += remainingStepKm;
                    distanceCovered = Math.min(totalDistKm, distanceCovered + remainingStepKm);
                    remainingStepKm = 0;
                }
            }

            if (currentSegIndex >= animCoords.length - 1) {
                distanceCovered = totalDistKm;
            }

            const activeP1 = animCoords[Math.min(currentSegIndex, animCoords.length - 1)];
            const activeP2 = animCoords[Math.min(currentSegIndex + 1, animCoords.length - 1)];
            const activeSegLength = currentSegIndex < animCoords.length - 1
                ? Math.max(0, cumulativeDistances[currentSegIndex + 1] - cumulativeDistances[currentSegIndex])
                : 0;
            const ratio = activeSegLength > 0 ? currentSegProgressKm / activeSegLength : 0;

            // 6. Lock the marker to the displayed sea-route geometry instead of cutting corners over land.
            const [curLat, curLon] = interpolateSegment(activeP1, activeP2, ratio);

            const roundedHeading = Math.round(currentHeading);

            // Move marker on map
            marker.setLatLng([curLat, curLon]);

            // Sync with SimulationShip state & render directional arrow along the emergency sea route segment
            if (window.SimulationShip?.setSimPosition) {
                window.SimulationShip.setSimPosition(curLat, curLon, roundedHeading);
            }
            if (window.SimulationShip?.renderPathArrow) {
                window.SimulationShip.renderPathArrow(curLat, curLon, activeP2[0], activeP2[1], roundedHeading);
            }

            // Update floating coordinate display live
            const latEl = document.getElementById('latValue');
            const lngEl = document.getElementById('lngValue');
            if (latEl) latEl.textContent = curLat.toFixed(6);
            if (lngEl) lngEl.textContent = curLon.toFixed(6);

            // Update marker rotation element if available
            const iconEl = marker.getElement();
            if (iconEl) {
                const rotator = iconEl.querySelector('.sim-rotator') || iconEl.querySelector('.ship-rotator') || iconEl.querySelector('.standalone-ship-wrapper') || iconEl.querySelector('svg');
                if (rotator) {
                    rotator.style.transform = `rotate(${roundedHeading}deg)`;
                }
            }

            // Remaining Telemetry Calculations
            const distRemainingKm = Math.max(0, totalDistKm - distanceCovered);
            const distRemainingNm = distRemainingKm * 0.539957;

            const remainingHours = distRemainingKm / speedKmh;
            const remH = Math.floor(remainingHours);
            const remM = Math.round((remainingHours - remH) * 60);
            const etaFormatted = `${remH}h ${remM}m remaining`;
            const animProgressPct = totalDistKm > 0 ? ((distanceCovered / totalDistKm) * 100).toFixed(1) + '%' : '100%';

            // (Frame-level telemetry logged via onTick callback — avoid console spam at 60fps)

            const telemetry = {
                lat: curLat,
                lon: curLon,
                lng: curLon,
                latitude: curLat,
                longitude: curLon,
                heading: roundedHeading,
                speedKnots: validSpeedKnots.toFixed(1),
                remainingFuelPct: remainingFuelPct.toFixed(1),
                burnedFuelPct: burnedFuelPct.toFixed(1),
                distanceRemainingKm: distRemainingKm.toFixed(1),
                distanceRemainingNm: distRemainingNm.toFixed(1),
                etaRemaining: etaFormatted,
                progressPercent: Math.round((distanceCovered / totalDistKm) * 100)
            };

            if (typeof onTick === 'function') onTick(telemetry);
            if (window.TimeSim?.updateLiveTelemetry) window.TimeSim.updateLiveTelemetry(telemetry);

            _animFrame = requestAnimationFrame(animateStep);
        }

        _animFrame = requestAnimationFrame(animateStep);
        return true;
    }

    /** Stop animation */
    function stopAnimation() {
        if (_animFrame) {
            cancelAnimationFrame(_animFrame);
            _animFrame = null;
        }
        _isAnimating = false;
        if (window.SimulationShip?.clearPathArrow) {
            window.SimulationShip.clearPathArrow();
        }
    }

    return {
        init: (map) => { _map = map; },
        startRouteAnimation,
        stopAnimation,
        isAnimating: () => _isAnimating
    };
})();
