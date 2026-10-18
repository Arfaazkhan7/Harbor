/**
 * Maritime AI Digital Twin — Background Mission Engine
 * =====================================================
 * Starts IMMEDIATELY when a Simulation Ship is placed or moved.
 * Never waits for the Emergency button.
 *
 * Architecture:
 *   Ship Created/Moved
 *       │
 *       ├─► Instant: evaluate T=0 → window.currentMission (renders Digital Twin)
 *       │
 *       └─► Background: prewarm all 8 offsets in parallel
 *               [0, 30, 60, 120, 240, 360, 720, 1440 min]
 *               → window.missionCache
 *               Also fires /api/emergency/find_route silently
 *               → window.emergencyCache (instant on button press)
 *
 * Global API (window.MissionEngine):
 *   MissionEngine.startMission(ship)       — called by SimulationShip.onUpdate
 *   MissionEngine.getMission(offsetMin)    — returns cached or triggers fetch
 *   MissionEngine.getEmergency()           — returns cached emergency route
 *   MissionEngine.isPrewarmed()            — true if all offsets loaded
 *   MissionEngine.clearMission()           — cancel + reset
 */

const MissionEngine = (function () {
    'use strict';

    // ── State ─────────────────────────────────────────────────────────────────
    let _ship           = null;           // Current simulation ship state
    let _startTimeIso   = null;           // Mission start ISO timestamp
    let _missionId      = 0;             // Increments on every new mission (cancel guard)
    let _prewarmed      = false;
    let _prewarmAbort   = null;           // AbortController for in-flight prewarm
    let _refreshTimer   = null;           // 10-minute background refresh

    // ── Caches ────────────────────────────────────────────────────────────────
    /** Full mission cache: key = offset minutes (string) → { currentMission } */
    window.missionCache   = {};
    /** Emergency route cache: full result from /api/emergency/find_route */
    window.emergencyCache = null;
    /** Shared current mission (T=0 by default, updated by slider) */
    window.currentMission = null;

    // All prediction offsets (minutes)
    const OFFSETS = [0, 30, 60, 120, 240, 360, 720, 1440];

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _buildPayload(overrideOffset) {
        if (!_ship) return null;
        const portId = window.emergencyCache?.selected_port?.id
                    || window.currentMission?.current?.selectedPort?.id
                    || null;
        return {
            ship: {
                name:        _ship.name    || 'SIMULATION VESSEL',
                initial_lat: _ship.lat,
                initial_lon: _ship.lon,
                heading:     _ship.heading || 0,
                speed:       _ship.speed   || 12,
                fuel:        _ship.fuel    || 80
            },
            sim_offset_min:  overrideOffset !== undefined ? overrideOffset : 0,
            start_time_iso:  _startTimeIso,
            current_port_id: portId
        };
    }

    function _log(msg) {
        console.log(`[MissionEngine] ${msg}`);
    }

    function _isAborted(capturedId) {
        return capturedId !== _missionId;
    }

    // ── PHASE 1: Instant T=0 Fetch ────────────────────────────────────────────

    /**
     * Fetches T=0 mission immediately to populate Digital Twin.
     * Called synchronously on ship creation/move.
     */
    async function _fetchInstant(missionId) {
        const payload = _buildPayload(0);
        if (!payload) return;

        try {
            const res  = await fetch('/api/mission_update', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(payload)
            });
            if (_isAborted(missionId)) return;

            const data = await res.json();
            if (_isAborted(missionId)) return;

            if (data.success && data.currentMission) {
                window.missionCache['0'] = data.currentMission;
                window.currentMission   = data.currentMission;

                // Fire Digital Twin renderer
                if (window.TimeSim?.renderFromMission) {
                    window.TimeSim.renderFromMission(data.currentMission, 0);
                }

                // Add timeline event
                _addTimelineEvent('success', `🚀 Mission Engine started for ${_ship.name || 'VESSEL'} — AI Digital Twin is LIVE`);
                _log(`T=0 instant load done. Port: ${data.currentMission.current?.selectedPort?.PORT_NAME}`);
            }
        } catch (err) {
            _log(`T=0 fetch error: ${err.message}`);
        }
    }

    // ── PHASE 2: Background Pre-warm (all 8 offsets) ─────────────────────────

    /**
     * Calls /api/mission_prewarm to get all 8 offsets in parallel.
     * Stores into window.missionCache.
     * Also fires emergency route pre-computation in background.
     */
    async function _prewarm(missionId) {
        const payload = _buildPayload(0);
        if (!payload) return;

        _log('Starting background pre-warm for all 8 time offsets...');

        // Use AbortController so we can cancel if ship moves
        _prewarmAbort = new AbortController();

        try {
            const res  = await fetch('/api/mission_prewarm', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(payload),
                signal:  _prewarmAbort.signal
            });
            if (_isAborted(missionId)) return;

            const data = await res.json();
            if (_isAborted(missionId)) return;

            if (data.success && data.cache) {
                // Merge into global cache
                for (const [key, mission] of Object.entries(data.cache)) {
                    window.missionCache[key] = mission.currentMission || mission;
                }

                // Set T=0 from prewarm if not already set
                if (window.missionCache['0'] && !window.currentMission) {
                    window.currentMission = window.missionCache['0'];
                    if (window.TimeSim?.renderFromMission) {
                        window.TimeSim.renderFromMission(window.currentMission, 0);
                    }
                }

                _prewarmed = true;
                _log(`Pre-warm complete. Loaded offsets: ${data.completed_offsets?.join(', ')} min`);
                _addTimelineEvent('success', `⚡ All ${data.completed_offsets?.length || 8} prediction intervals pre-loaded — instant response ready`);

                // Build risk trend chart now that we have all data
                if (window.TimeSim?.buildRiskTrend) {
                    window.TimeSim.buildRiskTrend(window.missionCache);
                }

                // Phase 3: Background emergency route
                _prefetchEmergencyRoute(missionId);
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                _log('Pre-warm aborted (ship moved)');
            } else {
                _log(`Pre-warm error: ${err.message}`);
            }
        }
    }

    // ── PHASE 3: Background Emergency Route Pre-fetch ─────────────────────────

    /**
     * Pre-fetches the emergency route so button press is instant.
     * Runs silently after pre-warm completes.
     */
    async function _prefetchEmergencyRoute(missionId) {
        if (!_ship) return;
        _log('Pre-fetching emergency route in background...');

        try {
            const res  = await fetch('/api/emergency/find_route', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    ship_lat:   _ship.lat,
                    ship_lon:   _ship.lon,
                    ship_speed: _ship.speed || 15
                })
            });
            if (_isAborted(missionId)) return;

            const data = await res.json();
            if (_isAborted(missionId)) return;

            if (data.success) {
                window.emergencyCache = data;
                _log(`Emergency route cached: ${data.selected_port?.PORT_NAME} — ${data.sea_route_distance_km} km`);
                _addTimelineEvent('warning', `🚨 Emergency Route pre-computed → ${data.selected_port?.PORT_NAME} (${data.sea_route_distance_km} km) — Ready for instant dispatch`);

                // Notify TimeSim that emergency cache is ready
                if (window.TimeSim?.onEmergencyCacheReady) {
                    window.TimeSim.onEmergencyCacheReady(data);
                }
            }
        } catch (err) {
            _log(`Emergency pre-fetch error: ${err.message}`);
        }
    }

    // ── Timeline Event Store ──────────────────────────────────────────────────

    /** Add an event to the global mission timeline */
    function _addTimelineEvent(type, description) {
        if (!window.currentMission) return;
        const ts  = new Date().toISOString().slice(11, 16) + ' UTC';
        const evt = { ts, type, description };

        // Prepend so newest events are at top
        if (!window.currentMission.timeline) window.currentMission.timeline = [];
        window.currentMission.timeline.unshift(evt);

        // Keep last 20 events
        if (window.currentMission.timeline.length > 20) {
            window.currentMission.timeline = window.currentMission.timeline.slice(0, 20);
        }

        // Live-update timeline in UI
        if (window.TimeSim?.refreshTimeline) {
            window.TimeSim.refreshTimeline(window.currentMission.timeline);
        }
    }

    // ── Background Refresh ────────────────────────────────────────────────────

    /** Re-warms the cache silently every 10 minutes */
    function _scheduleRefresh() {
        if (_refreshTimer) clearInterval(_refreshTimer);
        _refreshTimer = setInterval(() => {
            if (_ship) {
                const id = _missionId;
                _log('Scheduled 10-min background refresh starting...');
                _prewarm(id);
                _addTimelineEvent('info', '🔄 Weather & prediction data refreshed (10-min cycle)');
            }
        }, 600_000);
    }

    // ── PUBLIC API ────────────────────────────────────────────────────────────

    let _lastStartedLat = null;
    let _lastStartedLon = null;

    /**
     * Start (or restart) the mission engine for the given ship state.
     * Called by SimulationShip.onUpdate() on ship placement/arrival.
     *
     * @param {Object} ship - { lat, lon, heading, speed, fuel, name }
     */
    function startMission(ship) {
        if (!ship || ship.lat === undefined || ship.lon === undefined) return;

        // Skip if position hasn't moved significantly (> 10 meters)
        if (_lastStartedLat !== null && _lastStartedLon !== null) {
            const dLat = Math.abs(ship.lat - _lastStartedLat);
            const dLon = Math.abs(ship.lon - _lastStartedLon);
            if (dLat < 0.0001 && dLon < 0.0001) return;
        }

        _lastStartedLat = ship.lat;
        _lastStartedLon = ship.lon;

        // Cancel previous mission
        _missionId++;
        const myId = _missionId;
        _prewarmed = false;
        window.missionCache   = {};
        window.emergencyCache = null;

        if (_prewarmAbort) {
            _prewarmAbort.abort();
            _prewarmAbort = null;
        }

        _ship         = { ...ship };
        _startTimeIso = new Date().toISOString();

        _log(`New mission #${myId} started. Ship: ${ship.name} @ [${ship.lat?.toFixed(4)}, ${ship.lon?.toFixed(4)}]`);

        // Phase 1: Instant T=0 render
        _fetchInstant(myId);

        // Phase 2: Background pre-warm (parallel, after a tiny delay so Phase 1 goes first)
        setTimeout(() => _prewarm(myId), 100);

        // Schedule 10-min refresh
        _scheduleRefresh();

        // Add mission started event to timeline later (after Phase 1 sets window.currentMission)
        setTimeout(() => {
            _addTimelineEvent('success', `📍 Ship relocated to [${ship.lat?.toFixed(4)}, ${ship.lon?.toFixed(4)}] — Mission recalculated`);
        }, 500);
    }

    async function _fetchSingleOffset(offsetMin) {
        const payload = _buildPayload(offsetMin);
        if (!payload) return;
        try {
            const res = await fetch('/api/mission_update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (data.success && data.currentMission) {
                const key = String(offsetMin);
                window.missionCache[key] = data.currentMission;
                if (window.TimeSim?._currentOffset === offsetMin) {
                    window.currentMission = data.currentMission;
                    window.TimeSim.renderFromMission(data.currentMission, offsetMin);
                }
            }
        } catch (err) {
            _log(`Single offset fetch error for ${offsetMin}m: ${err.message}`);
        }
    }

    /**
     * Trigger emergency mission state and re-prewarm predictions for selected emergency port.
     */
    function triggerEmergency(emergencyData) {
        if (!emergencyData) return;
        window.emergencyCache = emergencyData;

        const myId = _missionId;
        _log(`Emergency Route triggered for ${emergencyData.selected_port?.PORT_NAME}. Re-calculating Digital Twin...`);
        _fetchInstant(myId);
        setTimeout(() => _prewarm(myId), 100);

        if (window.TimeSim?.onEmergencyRoute) {
            window.TimeSim.onEmergencyRoute(emergencyData, _ship?.name);
        }
    }

    /**
     * Get mission data for a given time offset.
     * Returns cached immediately if available. Triggers background fetch if stale.
     *
     * @param {number} offsetMin - Time offset in minutes
     * @returns {Object|null} Mission data or null
     */
    function getMission(offsetMin) {
        // Round to nearest valid offset
        const snapped = _snapOffset(offsetMin);
        const key     = String(snapped);

        const cached = window.missionCache[key];
        if (cached) {
            window.currentMission = cached;
            return cached;
        }

        // Not in cache — fetch in background, return T=0 immediately as fallback
        _fetchSingleOffset(snapped);
        return window.missionCache['0'] || window.currentMission;
    }

    /**
     * Get the cached emergency route (instant — no API call).
     * Returns null if not yet computed.
     */
    function getEmergency() {
        return window.emergencyCache;
    }

    /** Whether all 8 offsets are pre-warmed */
    function isPrewarmed() {
        return _prewarmed;
    }

    /** Clear and reset everything */
    function clearMission() {
        _missionId++;
        _ship           = null;
        _startTimeIso   = null;
        _prewarmed      = false;
        window.missionCache   = {};
        window.emergencyCache = null;
        window.currentMission = null;
        if (_prewarmAbort) _prewarmAbort.abort();
        if (_refreshTimer) clearInterval(_refreshTimer);
        _log('Mission cleared.');
    }

    /** Add a timeline event from any module */
    function addEvent(type, description) {
        _addTimelineEvent(type, description);
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    function _snapOffset(minutes) {
        const sorted = [0, 30, 60, 120, 240, 360, 720, 1440];
        let best = sorted[0], bestDiff = Math.abs(minutes - sorted[0]);
        for (const v of sorted) {
            const diff = Math.abs(minutes - v);
            if (diff < bestDiff) { bestDiff = diff; best = v; }
        }
        return best;
    }

    async function _fetchSingleOffset(offsetMin) {
        const payload = _buildPayload(offsetMin);
        if (!payload) return;
        try {
            const res  = await fetch('/api/mission_update', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(payload)
            });
            const data = await res.json();
            if (data.success && data.currentMission) {
                window.missionCache[String(offsetMin)] = data.currentMission;
                // If this is the currently displayed offset, refresh UI
                if (window.TimeSim?._currentOffset === offsetMin) {
                    window.TimeSim.renderFromMission(data.currentMission, offsetMin);
                }
            }
        } catch (err) {
            _log(`Single offset ${offsetMin}m fetch error: ${err.message}`);
        }
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    function init() {
        // Hook into SimulationShip onUpdate — fires on every ship placement/drag
        if (window.SimulationShip) {
            window.SimulationShip.onUpdate((ship) => {
                if (!ship) return;
                startMission(ship);
                // Also wire to TimeSim for legacy compat
                if (window.TimeSim?.onShipUpdate) window.TimeSim.onShipUpdate(ship);
            });
            _log('Hooked into SimulationShip.onUpdate');
        } else {
            _log('WARNING: SimulationShip not available yet');
        }
    }

    async function fetchOffset(offsetMin) {
        const snap = _snapOffset(offsetMin);
        if (window.missionCache[String(snap)]) {
            const cached = window.missionCache[String(snap)];
            if (window.TimeSim?.renderFromMission) {
                window.TimeSim.renderFromMission(cached, snap);
            }
            return cached;
        }
        await _fetchSingleOffset(snap);
        return window.missionCache[String(snap)] || null;
    }

    const api = {
        init,
        startMission,
        getMission,
        fetchOffset,
        getEmergency,
        triggerEmergency,
        isPrewarmed,
        clearMission,
        addEvent
    };
    if (typeof window !== 'undefined') window.MissionEngine = api;
    return api;

})();
