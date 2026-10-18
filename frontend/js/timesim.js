/**
 * Maritime AI Digital Twin — Complete Digital Twin Hub
 * =====================================================
 * Pure renderer: reads ONLY from window.currentMission + window.missionCache.
 * Never makes direct API calls — all data comes from MissionEngine.
 *
 * Sections:
 *   0. Emergency Mission Banner (appears when /api/emergency/find_route is ready)
 *   1. Current Mission (T=0 live state)
 *   2. Risk Analysis (explainable per-factor breakdown)
 *   3. Forecast Weather (live + route-sampled)
 *   4. Future Prediction Engine (slider + ship movement)
 *   5. Recommended Port (with AI score card)
 *   6. Mission Timeline (auto-generated events)
 *   7. Top-5 Candidate Ports
 *
 * Global API: window.TimeSim
 *   TimeSim.renderFromMission(mission, offsetMin)
 *   TimeSim.onShipUpdate(ship)
 *   TimeSim.onEmergencyCacheReady(emergencyData)
 *   TimeSim.buildRiskTrend(missionCache)
 *   TimeSim.refreshTimeline(events)
 *   TimeSim._currentOffset (property)
 */

const TimeSim = (function () {
    'use strict';

    // ── State ─────────────────────────────────────────────────────────────────
    let _map            = null;
    let _panelVisible   = false;
    let _currentOffset  = 0;
    let _debounceTimer  = null;
    let _baseShip       = null;
    let _emergencyData  = null;
    let _riskTrend      = [];

    // Valid slider offsets in minutes
    const OFFSETS = [0, 30, 60, 120, 240, 360, 720, 1440];

    // ── Color Helpers ─────────────────────────────────────────────────────────

    function _sevColor(severity) {
        const s = (severity || 'safe').toLowerCase();
        return s === 'danger' ? '#ef4444' : s === 'rough' ? '#f97316' : s === 'moderate' ? '#eab308' : '#10b981';
    }

    function _fuelColor(pct) {
        return pct < 25 ? '#ef4444' : pct < 50 ? '#f97316' : '#10b981';
    }

    function _riskBadge(prob) {
        if (prob >= 75) return ['badge-critical', 'CRITICAL RISK'];
        if (prob >= 50) return ['badge-high',     'HIGH RISK'];
        if (prob >= 25) return ['badge-medium',   'ELEVATED'];
        return               ['badge-low',        'LOW RISK'];
    }

    function _safetyColor(score) {
        return score >= 75 ? '#10b981' : score >= 55 ? '#eab308' : score >= 35 ? '#f97316' : '#ef4444';
    }

    // ── AI Explainability Breakdown ───────────────────────────────────────────

    /**
     * Renders a full per-factor safety score breakdown.
     * Shows every risk factor with its contribution and direction (adds/reduces risk).
     */
    function _renderSafetyBreakdown(score, breakdown, weather) {
        const sc   = score || 80;
        const bk   = breakdown || {};
        const wth  = weather   || {};
        const col  = _safetyColor(sc);
        const label = sc >= 75 ? 'GOOD' : sc >= 55 ? 'MODERATE' : sc >= 35 ? 'DANGER' : 'CRITICAL';

        // Build factor list for AI Explainability (Task: never just show "Safety 35")
        const factors = [
            {
                label: 'Wave Height',
                val:   bk.waveHeight      || 0,
                max:   35,
                color: '#3b82f6',
                icon:  '🌊',
                note:  `${wth.wave_height || 0}m`,
                adds:  true
            },
            {
                label: 'Wind Speed',
                val:   bk.windSpeed       || 0,
                max:   25,
                color: '#6366f1',
                icon:  '💨',
                note:  `${wth.wind_speed || 0} km/h`,
                adds:  true
            },
            {
                label: 'Storm Probability',
                val:   bk.stormProbability || 0,
                max:   15,
                color: '#dc2626',
                icon:  '⛈',
                note:  `${Math.round((bk.stormProbability || 0) / 15 * 100)}%`,
                adds:  true
            },
            {
                label: 'Fuel Usage',
                val:   bk.fuelLevel       || 0,
                max:   20,
                color: '#f97316',
                icon:  '⛽',
                note:  `${100 - Math.round((bk.fuelLevel || 0) / 20 * 100)}% remain`,
                adds:  true
            },
            {
                label: 'Route Length',
                val:   bk.distanceToPort  || 0,
                max:   10,
                color: '#eab308',
                icon:  '📏',
                note:  'long route',
                adds:  true
            },
            {
                label: 'Weather Severity',
                val:   bk.weatherSeverity || 0,
                max:   20,
                color: '#ef4444',
                icon:  '🌡',
                note:  (wth.severity || 'safe').toUpperCase(),
                adds:  true
            },
            {
                label: 'Night Navigation',
                val:   bk.nightNavigation || 0,
                max:   5,
                color: '#8b5cf6',
                icon:  '🌙',
                note:  bk.nightNavigation > 0 ? 'active' : 'daytime',
                adds:  bk.nightNavigation > 0
            },
            {
                label: 'Ocean Current',
                val:   Math.max(0, 5 - (wth.ocean_current || 0) * 2),
                max:   5,
                color: '#10b981',
                icon:  '🌊',
                note:  `${wth.ocean_current || 0} kn`,
                adds:  false   // Low current REDUCES risk
            }
        ];

        const barsHTML = factors.map(f => {
            const pct  = Math.min(100, Math.round((f.val / f.max) * 100));
            const sign = f.adds ? '+' : '−';
            const signColor = f.adds ? (f.val > 0 ? '#f97316' : '#64748b') : '#10b981';
            return `
            <div style="margin-bottom:5px;">
                <div style="display:flex;justify-content:space-between;align-items:center;font-size:8.5px;margin-bottom:2px;">
                    <span style="color:#94a3b8;">${f.icon} ${f.label} <span style="color:#475569;">(${f.note})</span></span>
                    <span style="color:${signColor};font-weight:700;font-family:'JetBrains Mono',monospace;">${sign}${f.val.toFixed ? f.val.toFixed(1) : f.val}</span>
                </div>
                <div style="background:rgba(255,255,255,0.05);height:4px;border-radius:2px;overflow:hidden;">
                    <div style="width:${pct}%;height:100%;background:${f.color};border-radius:2px;transition:width 0.5s ease;"></div>
                </div>
            </div>`;
        }).join('');

        return `
        <div style="background:rgba(0,0,0,0.25);border-radius:8px;padding:10px;border:1px solid rgba(255,255,255,0.05);">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
                <div style="font-size:26px;font-weight:900;color:${col};font-family:'JetBrains Mono',monospace;line-height:1;">${sc}</div>
                <div style="flex:1;">
                    <div style="font-size:8px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Safety Score / 100</div>
                    <div style="font-size:11px;font-weight:800;color:${col};letter-spacing:0.5px;">${label}</div>
                    <div style="background:rgba(255,255,255,0.05);height:5px;border-radius:3px;margin-top:4px;overflow:hidden;">
                        <div style="width:${sc}%;height:100%;background:${col};border-radius:3px;transition:width 0.6s ease;"></div>
                    </div>
                </div>
            </div>
            <div style="font-size:8px;color:#475569;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">AI RISK EXPLAINABILITY</div>
            ${barsHTML}
        </div>`;
    }

    // ── Port Score Card ───────────────────────────────────────────────────────

    /**
     * Renders a full AI-scored port card with all required fields.
     * Shown for recommended port AND top-5 list.
     */
    function _renderPortCard(port, isRecommended, routeData, weather) {
        if (!port) return '<div style="color:#475569;font-size:10px;">No port data</div>';

        const sc = routeData?.safety_score || port.port_score_info?.safety || 80;
        const scColor = _safetyColor(sc);
        const eta   = routeData?.eta?.formatted_duration || port.eta_formatted || '--';
        const distKm = routeData?.sea_route_distance_km || port.distance_km || 0;
        const distNm = routeData?.sea_route_distance_nm || port.distance_nm || 0;
        const fuel   = routeData?.fuel_tons || ((distKm * 0.08).toFixed(1));
        const wh     = weather?.wave_height || 0;
        const ws     = weather?.wind_speed  || 0;
        const stormPct = Math.round(Math.min(100, (wh / 6) * 100 * 0.5 + (ws / 90) * 100 * 0.5));
        const recBadge = isRecommended
            ? `<span style="background:#16a34a;color:#fff;font-size:8px;font-weight:800;padding:2px 7px;border-radius:4px;letter-spacing:0.5px;">⭐ RECOMMENDED</span>`
            : '';

        return `
        <div style="background:${isRecommended ? 'rgba(16,163,74,0.07)' : 'rgba(0,0,0,0.15)'};
                    border:1px solid ${isRecommended ? 'rgba(16,163,74,0.4)' : '#1e3a5f'};
                    border-radius:8px;padding:10px;margin-bottom:7px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px;">
                <div>
                    <div style="font-size:12px;font-weight:800;color:#e2e8f0;">⚓ ${port.PORT_NAME || '--'}</div>
                    <div style="font-size:9px;color:#64748b;margin-top:1px;">${port.COUNTRY || ''} • ${port.HARBORSIZE || ''} harbor</div>
                </div>
                ${recBadge}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px;margin-bottom:6px;">
                <div class="dt-kv-box" style="text-align:center;">
                    <div class="dt-kv-lbl">Distance</div>
                    <div class="dt-kv-val cyan">${distKm} km</div>
                    <div style="font-size:8px;color:#475569;">${distNm} NM</div>
                </div>
                <div class="dt-kv-box" style="text-align:center;">
                    <div class="dt-kv-lbl">ETA</div>
                    <div class="dt-kv-val" style="font-size:10px;">${eta}</div>
                </div>
                <div class="dt-kv-box" style="text-align:center;">
                    <div class="dt-kv-lbl">Fuel Req.</div>
                    <div class="dt-kv-val amber">${fuel} T</div>
                </div>
                <div class="dt-kv-box" style="text-align:center;">
                    <div class="dt-kv-lbl">Avg Wave</div>
                    <div class="dt-kv-val">${wh}m</div>
                </div>
                <div class="dt-kv-box" style="text-align:center;">
                    <div class="dt-kv-lbl">Max Wind</div>
                    <div class="dt-kv-val">${ws} km/h</div>
                </div>
                <div class="dt-kv-box" style="text-align:center;">
                    <div class="dt-kv-lbl">Storm Prob</div>
                    <div class="dt-kv-val ${stormPct > 50 ? 'red' : stormPct > 25 ? 'amber' : 'green'}">${stormPct}%</div>
                </div>
                <div class="dt-kv-box" style="text-align:center;">
                    <div class="dt-kv-lbl">Route Risk</div>
                    <div class="dt-kv-val ${sc < 55 ? 'red' : 'green'}">${100 - sc}</div>
                </div>
                <div class="dt-kv-box" style="text-align:center;">
                    <div class="dt-kv-lbl">Safety</div>
                    <div class="dt-kv-val" style="color:${scColor};">${sc}/100</div>
                </div>
                <div class="dt-kv-box" style="text-align:center;">
                    <div class="dt-kv-lbl">Score</div>
                    <div class="dt-kv-val" style="color:${scColor};font-size:10px;">${port.port_score?.toFixed ? port.port_score.toFixed(0) : (100 - sc)}</div>
                </div>
            </div>
            ${isRecommended ? `
            <div style="display:flex;gap:5px;margin-top:6px;">
                <button class="dt-start-journey-btn" style="flex:1;background:#16a34a;color:#fff;border:none;padding:8px;border-radius:7px;font-weight:700;font-size:11px;cursor:pointer;font-family:'Inter',sans-serif;transition:all 0.2s ease;">🟢 START EMERGENCY JOURNEY</button>
                <button class="dt-why-port-btn" style="background:#1e3a5f;color:#93c5fd;border:1px solid #1d4ed8;padding:8px 12px;border-radius:7px;font-weight:700;font-size:11px;cursor:pointer;font-family:'Inter',sans-serif;">❓ WHY?</button>
            </div>` : `
            <button onclick="MaritimeRoute.selectPortAndRecalculate('${port.id}')" style="width:100%;background:#102338;color:#38bdf8;border:1px solid #1e3a5f;padding:6px;border-radius:6px;font-size:10px;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;margin-top:4px;">⚓ VIEW ROUTE TO THIS PORT</button>`}
        </div>`;
    }

    // ── Risk Trend Chart ──────────────────────────────────────────────────────

    function buildRiskTrend(cache) {
        _riskTrend = [];
        for (const [key, data] of Object.entries(cache || {})) {
            const mission = data?.currentMission || data;
            if (mission) {
                _riskTrend.push({
                    offset: parseInt(key, 10),
                    risk:   mission.forecast?.emergencyProbability ?? 0,
                    safety: mission.forecast?.safetyScore ?? 80,
                    wave:   mission.forecast?.weather?.wave_height ?? 0,
                    wind:   mission.forecast?.weather?.wind_speed ?? 0
                });
            }
        }
        _riskTrend.sort((a, b) => a.offset - b.offset);
        _renderRiskTrendChart();
    }

    function _renderRiskTrendChart() {
        const el = document.getElementById('dtRiskTrendChart');
        if (!el || _riskTrend.length < 2) return;

        const W = 330, H = 70;
        const n = _riskTrend.length;
        const xStep = W / (n - 1);

        const riskPts = _riskTrend.map((p, i) =>
            `${(i * xStep).toFixed(1)},${(H - (p.risk / 100) * H).toFixed(1)}`
        ).join(' ');
        const safePts = _riskTrend.map((p, i) =>
            `${(i * xStep).toFixed(1)},${(H - (p.safety / 100) * H).toFixed(1)}`
        ).join(' ');
        const wavePts = _riskTrend.map((p, i) =>
            `${(i * xStep).toFixed(1)},${(H - Math.min(1, p.wave / 8) * H).toFixed(1)}`
        ).join(' ');

        const labels = _riskTrend.map((p, i) => {
            const x = (i * xStep).toFixed(1);
            const lbl = p.offset === 0 ? 'Now' : p.offset < 60 ? `+${p.offset}m` : `+${p.offset / 60}h`;
            return `<text x="${x}" y="${H + 13}" text-anchor="middle" fill="#64748b" font-size="7.5" font-family="JetBrains Mono,monospace">${lbl}</text>`;
        }).join('');

        el.innerHTML = `
        <div style="font-size:8.5px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">📈 24H RISK FORECAST TREND</div>
        <svg width="${W}" height="${H + 18}" viewBox="0 0 ${W} ${H + 18}" style="overflow:visible;display:block;">
            <line x1="0" y1="${H*0.25}" x2="${W}" y2="${H*0.25}" stroke="#1e3a5f" stroke-width="0.5" stroke-dasharray="3,4" opacity="0.7"/>
            <line x1="0" y1="${H*0.5}"  x2="${W}" y2="${H*0.5}"  stroke="#1e3a5f" stroke-width="0.5" stroke-dasharray="3,4" opacity="0.7"/>
            <line x1="0" y1="${H*0.75}" x2="${W}" y2="${H*0.75}" stroke="#1e3a5f" stroke-width="0.5" stroke-dasharray="3,4" opacity="0.7"/>
            <polyline points="${wavePts}" fill="none" stroke="#38bdf8" stroke-width="1" opacity="0.4" stroke-dasharray="4,3"/>
            <polyline points="${safePts}" fill="none" stroke="#10b981" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.8"/>
            <polyline points="${riskPts}" fill="none" stroke="#ef4444" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.8"/>
            ${labels}
        </svg>
        <div style="display:flex;gap:12px;margin-top:3px;">
            <span style="font-size:7.5px;color:#10b981;font-weight:700;">─ Safety</span>
            <span style="font-size:7.5px;color:#ef4444;font-weight:700;">─ Risk</span>
            <span style="font-size:7.5px;color:#38bdf8;font-weight:700;">- - Wave</span>
        </div>`;
    }

    // ── Timeline Renderer ─────────────────────────────────────────────────────

    function refreshTimeline(events) {
        const el = document.getElementById('dtTimelineList');
        if (!el || !events) return;
        el.innerHTML = (events || []).map(e => `
        <li class="dt-tl-item">
            <div class="dt-tl-dot dot-${e.type || 'info'}"></div>
            <div>
                <div class="dt-tl-time">${e.ts}</div>
                <div class="dt-tl-text">${e.description}</div>
            </div>
        </li>`).join('');
    }

    let _userSelectedOffset = 0;

    // ── MAIN RENDER ENGINE ────────────────────────────────────────────────────

    function renderFromMission(mission, offsetMin) {
        if (!mission) return;
        if (offsetMin !== undefined && offsetMin !== null) {
            _currentOffset = offsetMin;
            _userSelectedOffset = offsetMin;
        } else {
            _currentOffset = _userSelectedOffset || 0;
        }

        // Sync to missionCache so MissionEngine._currentOffset check works
        TimeSim_exports._currentOffset_val = _currentOffset;

        const curr = mission.current;
        const fore = mission.forecast;
        if (!curr || !fore) return;

        // ── Section 0: Emergency Banner ─────────────────────────────────────
        _renderEmergencySection();

        // ── Section 1: Current Mission ──────────────────────────────────────
        _renderCurrentMission(mission, curr);

        // ── Section 2: Risk Analysis ────────────────────────────────────────
        _renderRiskAnalysis(curr);

        // ── Section 3: Forecast Weather ─────────────────────────────────────
        _renderForecastWeather(curr, fore, mission);

        // ── Section 4: Future Prediction ────────────────────────────────────
        _renderPrediction(mission, fore, offsetMin);

        // ── Section 5: Recommended Port ─────────────────────────────────────
        _renderRecommendedPort(curr, fore, mission);

        // ── Section 6: Timeline ──────────────────────────────────────────────
        _renderTimeline(mission);

        // ── Section 7: Candidate Ports ──────────────────────────────────────
        _renderTop5Ports(curr);

        // ── Update Map Layers ────────────────────────────────────────────────
        _updateMap(fore);
    }

    // ── Section Renderers ─────────────────────────────────────────────────────

    function _renderEmergencySection() {
        const sec = document.getElementById('dtSecEmergency');
        if (!sec) return;

        if (_emergencyData) {
            const ed = _emergencyData;
            const sc = ed.safety_score ?? ed.safetyScore ?? 85;
            const scC = _safetyColor(sc);
            const isAnim = window.MaritimeAnimation?.isAnimating();
            const btnBg  = isAnim ? 'background:linear-gradient(135deg,#dc2626,#991b1b);' : 'background:linear-gradient(135deg,#16a34a,#15803d);';
            const btnTxt = isAnim ? '🛑 PAUSE JOURNEY' : '🟢 START EMERGENCY JOURNEY';

            sec.style.display = 'block';
            sec.innerHTML = `
            <div class="dt-card" style="border-color:rgba(239,68,68,0.55);border-width:1.5px;background:linear-gradient(135deg,rgba(127,7,7,0.12),rgba(0,0,0,0.2));">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <span style="background:rgba(239,68,68,0.15);color:#ef4444;font-size:9.5px;font-weight:800;padding:3px 9px;border-radius:4px;letter-spacing:0.5px;border:1px solid rgba(239,68,68,0.3);">🚨 EMERGENCY MISSION ACTIVE</span>
                    <div style="display:flex;gap:5px;align-items:center;">
                        <span style="font-size:8px;color:#10b981;font-weight:700;">⚡ INSTANT CACHE</span>
                        <button id="dtClearEmergencyBtn" style="background:none;border:1px solid #334155;color:#64748b;padding:2px 7px;border-radius:4px;cursor:pointer;font-size:10px;">✕</button>
                    </div>
                </div>
                <div style="font-size:14px;font-weight:800;color:#e2e8f0;margin-bottom:6px;">
                    → <span style="color:#10b981;">${ed.selected_port?.PORT_NAME || '--'}</span>
                    <span style="color:#64748b;font-weight:500;font-size:11px;">(${ed.selected_port?.COUNTRY || ''})</span>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:5px;margin-bottom:8px;">
                    <div class="dt-kv-box" style="text-align:center;">
                        <div class="dt-kv-lbl">Sea Route</div>
                        <div id="dtSec0Dist" class="dt-kv-val cyan">${ed.sea_route_distance_km} km</div>
                    </div>
                    <div class="dt-kv-box" style="text-align:center;">
                        <div class="dt-kv-lbl">ETA</div>
                        <div id="dtSec0Eta" class="dt-kv-val">${ed.eta?.formatted_duration || '--'}</div>
                    </div>
                    <div class="dt-kv-box" style="text-align:center;">
                        <div class="dt-kv-lbl">Safety</div>
                        <div class="dt-kv-val" style="color:${scC};">${sc}/100</div>
                    </div>
                    <div class="dt-kv-box" style="text-align:center;">
                        <div class="dt-kv-lbl">Fuel</div>
                        <div class="dt-kv-val amber">${ed.fuel_tons}T</div>
                    </div>
                </div>
                <div style="display:flex;gap:5px;">
                    <button id="dtStartJourneyBtn" class="dt-start-journey-btn" style="flex:1;${btnBg}color:#fff;border:none;padding:8px;border-radius:7px;font-weight:800;font-size:11px;cursor:pointer;font-family:'Inter',sans-serif;box-shadow:0 3px 14px rgba(22,163,74,0.4);">
                        ${btnTxt}
                    </button>
                    <button id="dtWhyPortBtn" style="background:#1e3a5f;color:#93c5fd;border:1px solid #1d4ed8;padding:8px 12px;border-radius:7px;font-weight:700;font-size:11px;cursor:pointer;">❓</button>
                </div>
            </div>`;

            document.getElementById('dtClearEmergencyBtn')?.addEventListener('click', () => {
                _emergencyData = null;
                _renderEmergencySection();
                if (window.MaritimeRoute?.clearRoute) window.MaritimeRoute.clearRoute();
                if (window.MissionEngine?.addEvent) window.MissionEngine.addEvent('info', '🚫 Emergency Mission cleared manually');
            });

            // Wire Start Journey button
            _wireJourneyButton();
        } else {
            sec.style.display = 'none';
            sec.innerHTML = '';
        }
    }

    function calcBearing(lat1, lon1, lat2, lon2) {
        const r = Math.PI / 180;
        const dL = (lon2 - lon1) * r;
        const y = Math.sin(dL) * Math.cos(lat2 * r);
        const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) -
            Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dL);
        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }

    function _wireJourneyButton() {
        if (window.MaritimeRoute?.updateJourneyButtonsState) {
            window.MaritimeRoute.updateJourneyButtonsState(window.MaritimeAnimation?.isAnimating());
        } else {
            const btns = document.querySelectorAll('.dt-start-journey-btn, #dtStartJourneyBtn');
            if (!btns || btns.length === 0) return;

            btns.forEach(b => {
                b.onclick = (e) => {
                    if (e) e.preventDefault();
                    if (window.MaritimeRoute?.startEmergencyJourney) {
                        window.MaritimeRoute.startEmergencyJourney();
                    }
                };
            });
        }
    }

    function _renderCurrentMission(mission, curr) {
        const el = document.getElementById('dtSec1');
        if (!el || !curr) return;

        const sevColor = _sevColor(curr.weather?.severity);
        const fuelColor = _fuelColor(curr.fuel?.remaining_pct);

        el.innerHTML = `
        <div class="dt-card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                <div>
                    <div style="font-size:14px;font-weight:800;color:#e2e8f0;">🚢 ${mission.shipName || 'VESSEL'}</div>
                    <div id="dtShipCoords" style="font-size:8px;color:#64748b;font-family:'JetBrains Mono',monospace;margin-top:2px;">
                        ${curr.ship?.lat?.toFixed(5)}, ${curr.ship?.lon?.toFixed(5)}
                    </div>
                </div>
                <span style="font-size:9px;color:#10b981;font-family:'JetBrains Mono',monospace;background:rgba(16,185,129,0.1);padding:3px 8px;border-radius:4px;border:1px solid rgba(16,185,129,0.25);">T=0 LIVE</span>
            </div>
            <div class="dt-grid-2" style="margin-bottom:8px;">
                <div class="dt-kv-box">
                    <div class="dt-kv-lbl">Heading</div>
                    <div id="dtShipHdg" class="dt-kv-val">${curr.ship?.heading}° <span style="color:#64748b;font-size:9px;">${_headingLabel(curr.ship?.heading)}</span></div>
                </div>
                <div class="dt-kv-box">
                    <div class="dt-kv-lbl">Speed</div>
                    <div id="dtShipSpd" class="dt-kv-val cyan">${curr.ship?.speed} knots</div>
                </div>
                <div class="dt-kv-box">
                    <div class="dt-kv-lbl">Fuel Remaining</div>
                    <div id="dtShipFuel" class="dt-kv-val" style="color:${fuelColor};">${curr.fuel?.remaining_pct}%
                        <span style="font-size:8px;color:#475569;">(−${curr.fuel?.burned_pct}%)</span>
                    </div>
                </div>
                <div class="dt-kv-box">
                    <div class="dt-kv-lbl">Weather Now</div>
                    <div class="dt-kv-val" style="color:${sevColor};font-size:9.5px;">🌊${curr.weather?.wave_height}m 💨${curr.weather?.wind_speed}km/h</div>
                </div>
                <div class="dt-kv-box">
                    <div class="dt-kv-lbl">Distance to Port</div>
                    <div id="dtShipDist" class="dt-kv-val">${curr.distance?.to_port_km} km <span style="color:#475569;font-size:9px;">(${curr.route?.distance_nm} NM)</span></div>
                </div>
                <div class="dt-kv-box">
                    <div class="dt-kv-lbl">ETA</div>
                    <div id="dtShipEta" class="dt-kv-val green">${curr.eta?.formatted_duration || '—'}</div>
                </div>
            </div>
            <div style="font-size:8px;color:#475569;text-align:center;font-style:italic;">
                Mission Start: ${mission.start_time_iso?.slice(11, 19) || '--'} UTC
                ${window.emergencyCache ? ' &bull; <span style="color:#10b981;font-weight:700;">⚡ Emergency Cache Ready</span>' : ' &bull; <span style="color:#f97316;">⏳ Pre-warming...</span>'}
            </div>
        </div>`;
    }

    function updateLiveTelemetry(telemetry) {
        if (!telemetry) return;
        const coordsEl = document.getElementById('dtShipCoords');
        const hdgEl    = document.getElementById('dtShipHdg');
        const spdEl    = document.getElementById('dtShipSpd');
        const fuelEl   = document.getElementById('dtShipFuel');
        const distEl   = document.getElementById('dtShipDist');
        const etaEl    = document.getElementById('dtShipEta');
        const sec0Dist = document.getElementById('dtSec0Dist');
        const sec0Eta  = document.getElementById('dtSec0Eta');

        const latVal = telemetry.lat !== undefined ? telemetry.lat : telemetry.latitude;
        const lonVal = telemetry.lon !== undefined ? telemetry.lon : (telemetry.lng !== undefined ? telemetry.lng : telemetry.longitude);

        if (coordsEl && latVal !== undefined && lonVal !== undefined) {
            coordsEl.textContent = `${Number(latVal).toFixed(5)}, ${Number(lonVal).toFixed(5)}`;
        }
        if (hdgEl && telemetry.heading !== undefined) {
            hdgEl.innerHTML = `${telemetry.heading}° <span style="color:#64748b;font-size:9px;">${_headingLabel(telemetry.heading)}</span>`;
        }
        if (spdEl && telemetry.speedKnots) {
            spdEl.textContent = `${telemetry.speedKnots} knots`;
        }
        if (fuelEl && telemetry.remainingFuelPct !== undefined) {
            const fuelColor = _fuelColor(parseFloat(telemetry.remainingFuelPct));
            fuelEl.style.color = fuelColor;
            fuelEl.innerHTML = `${telemetry.remainingFuelPct}% <span style="font-size:8px;color:#475569;">(−${telemetry.burnedFuelPct || 0}%)</span>`;
        }
        if (distEl && telemetry.distanceRemainingKm !== undefined) {
            distEl.innerHTML = `${telemetry.distanceRemainingKm} km <span style="color:#475569;font-size:9px;">(${telemetry.distanceRemainingNm} NM)</span>`;
        }
        if (etaEl && telemetry.etaRemaining) {
            etaEl.textContent = telemetry.etaRemaining;
        }
        if (sec0Dist && telemetry.distanceRemainingKm !== undefined) {
            sec0Dist.textContent = `${telemetry.distanceRemainingKm} km`;
        }
        if (sec0Eta && telemetry.etaRemaining) {
            sec0Eta.textContent = telemetry.etaRemaining;
        }

        // Sync live telemetry state into window.currentMission so subsequent queries/renders reflect current position
        if (window.currentMission?.current?.ship && latVal !== undefined && lonVal !== undefined) {
            window.currentMission.current.ship.lat = latVal;
            window.currentMission.current.ship.lon = lonVal;
            window.currentMission.current.ship.lng = lonVal;
            window.currentMission.current.ship.heading = telemetry.heading;
            if (window.currentMission.forecast?.ship && (_currentOffset === 0 || !window.currentMission.sim_offset_min)) {
                window.currentMission.forecast.ship.lat = latVal;
                window.currentMission.forecast.ship.lon = lonVal;
                window.currentMission.forecast.ship.lng = lonVal;
                window.currentMission.forecast.ship.heading = telemetry.heading;
            }
            if (window.currentMission.current.fuel) {
                window.currentMission.current.fuel.remaining_pct = parseFloat(telemetry.remainingFuelPct || 100);
                window.currentMission.current.fuel.burned_pct = parseFloat(telemetry.burnedFuelPct || 0);
            }
        }
    }

    function _renderRiskAnalysis(curr) {
        const el = document.getElementById('dtSec2');
        if (!el || !curr) return;

        const [riskCls, riskLabel] = _riskBadge(curr.emergencyProbability || 0);
        el.innerHTML = `
        <div class="dt-card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                <span style="font-size:10px;font-weight:800;color:#e2e8f0;">AI Risk Explainability</span>
                <span class="risk-level-badge ${riskCls}">${riskLabel}</span>
            </div>
            ${_renderSafetyBreakdown(curr.safetyScore, curr.riskBreakdown, curr.weather)}
            <div class="dt-grid-2" style="margin-top:8px;">
                <div class="dt-kv-box">
                    <div class="dt-kv-lbl">Emergency Probability</div>
                    <div class="dt-kv-val ${curr.emergencyProbability >= 50 ? 'red' : 'green'}">${curr.emergencyProbability}%</div>
                </div>
                <div class="dt-kv-box">
                    <div class="dt-kv-lbl">AI Confidence</div>
                    <div class="dt-kv-val green">${curr.confidence}%</div>
                </div>
            </div>
        </div>`;
    }

    function _renderForecastWeather(curr, fore, mission) {
        const el = document.getElementById('dtSec3');
        if (!el) return;

        const w = curr.weather || {};
        const fw = fore.weather || {};
        const wCol  = _sevColor(w.severity);
        const fwCol = _sevColor(fw.severity);

        el.innerHTML = `
        <div class="dt-card">
            <div class="dt-grid-2" style="margin-bottom:8px;">
                <div style="border-radius:7px;padding:8px;background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);">
                    <div style="font-size:8.5px;font-weight:700;color:#10b981;text-transform:uppercase;margin-bottom:6px;">NOW (T=0)</div>
                    <div style="font-size:11px;color:#e2e8f0;font-family:'JetBrains Mono',monospace;">
                        <div>🌊 Wave: <strong>${w.wave_height}m</strong> @ ${w.wave_direction}°</div>
                        <div>💨 Wind: <strong>${w.wind_speed} km/h</strong> @ ${w.wind_direction}°</div>
                        <div>🌀 Current: <strong>${w.ocean_current} kn</strong> @ ${w.ocean_current_dir}°</div>
                        <div>⏱ Period: <strong>${w.wave_period}s</strong></div>
                        <div style="margin-top:4px;"><span style="color:${wCol};font-weight:800;">${(w.severity || 'safe').toUpperCase()}</span></div>
                    </div>
                </div>
                <div style="border-radius:7px;padding:8px;background:rgba(56,189,248,0.06);border:1px solid rgba(56,189,248,0.2);">
                    <div style="font-size:8.5px;font-weight:700;color:#38bdf8;text-transform:uppercase;margin-bottom:6px;">FORECAST (T+${Math.floor(mission.sim_offset_min/60)}h)</div>
                    <div style="font-size:11px;color:#e2e8f0;font-family:'JetBrains Mono',monospace;">
                        <div>🌊 Wave: <strong>${fw.wave_height}m</strong> @ ${fw.wave_direction}°</div>
                        <div>💨 Wind: <strong>${fw.wind_speed} km/h</strong> @ ${fw.wind_direction}°</div>
                        <div>🌀 Current: <strong>${fw.ocean_current} kn</strong> @ ${fw.ocean_current_dir}°</div>
                        <div>⏱ Period: <strong>${fw.wave_period}s</strong></div>
                        <div style="margin-top:4px;"><span style="color:${fwCol};font-weight:800;">${(fw.severity || 'safe').toUpperCase()}</span></div>
                    </div>
                </div>
            </div>
            <!-- Route Weather (sampled every 25km) placeholder -->
            <div style="font-size:8px;color:#475569;text-align:center;">
                Route weather sampled every 25 km along sea corridor
            </div>
        </div>`;
    }

    function _renderPrediction(mission, fore, offsetMin) {
        const el = document.getElementById('dtSec4');
        if (!el || !fore) return;

        const offH = Math.floor(mission.sim_offset_min / 60);
        const offM = mission.sim_offset_min % 60;
        const sliderStep = OFFSETS.indexOf(_snapOffset(mission.sim_offset_min));
        const sliderMax  = OFFSETS.length - 1;
        const sliderPct  = ((sliderStep) / sliderMax) * 100;
        const fuelColor  = _fuelColor(fore.fuel?.remaining_pct || 80);
        const fwCol      = _sevColor(fore.weather?.severity);
        const [riskCls, riskLabel] = _riskBadge(fore.emergencyProbability || 0);

        el.innerHTML = `
        <div class="ts-ctrl-box">
            <div class="ts-clock-row">
                <div class="ts-clock-box">
                    <div class="ts-clock-title">Mission Start</div>
                    <div class="ts-clock-time" style="color:#10b981;">${(mission.start_time_iso || '').slice(11, 16)} UTC</div>
                </div>
                <div class="ts-clock-box">
                    <div class="ts-clock-title">Simulation Time</div>
                    <div class="ts-clock-time">${(mission.forecast_time_iso || '').slice(11, 16)} UTC</div>
                </div>
            </div>

            <div class="ts-slider-wrap">
                <div class="ts-slider-labels">
                    <span>Now</span><span>+30m</span><span>+1h</span><span>+2h</span><span>+4h</span><span>+6h</span><span>+12h</span><span>+24h</span>
                </div>
                <input type="range" class="ts-slider" id="dtSlider"
                       min="0" max="${sliderMax}" step="1"
                       value="${Math.max(0, sliderStep)}"
                       style="--pct: ${sliderPct}%;"
                       aria-label="Time simulation slider">
            </div>

            <div style="text-align:center;font-size:11px;font-weight:700;color:#38bdf8;font-family:'JetBrains Mono',monospace;margin-bottom:8px;">
                ${mission.sim_offset_min === 0 ? 'Current Time (T=0)' : `T+${String(offH).padStart(2,'0')}:${String(offM).padStart(2,'0')} — ${offH}h ${offM > 0 ? offM + 'm' : ''} ahead`}
            </div>

            <div class="ts-btn-row">
                <button class="ts-btn" id="btnM30">−30m</button>
                <button class="ts-btn" id="btnP30">+30m</button>
                <button class="ts-btn" id="btnP1h">+1h</button>
                <button class="ts-btn" id="btnP2h">+2h</button>
                <button class="ts-btn" id="btnP4h">+4h</button>
                <button class="ts-btn" id="btnP6h">+6h</button>
                <button class="ts-btn" id="btnP12h">+12h</button>
                <button class="ts-btn ts-btn-reset" id="btnRst">Reset</button>
            </div>
        </div>

        <div class="dt-card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                <span style="font-size:11px;font-weight:800;color:#38bdf8;">🔮 PREDICTED (T+${offH}h${offM>0?' '+offM+'m':''})</span>
                <span class="risk-level-badge ${riskCls}">${riskLabel}</span>
            </div>
            <div class="dt-grid-2" style="margin-bottom:8px;">
                <div class="dt-kv-box">
                    <div class="dt-kv-lbl">Predicted Position</div>
                    <div class="dt-kv-val cyan" style="font-size:9px;">${fore.ship?.lat?.toFixed(4)}, ${fore.ship?.lon?.toFixed(4)}</div>
                </div>
                <div class="dt-kv-box">
                    <div class="dt-kv-lbl">Distance Moved</div>
                    <div class="dt-kv-val">${fore.distance?.moved_km} km</div>
                </div>
                <div class="dt-kv-box">
                    <div class="dt-kv-lbl">Predicted Fuel</div>
                    <div class="dt-kv-val" style="color:${fuelColor};">${fore.fuel?.remaining_pct}%</div>
                </div>
                <div class="dt-kv-box">
                    <div class="dt-kv-lbl">Predicted ETA</div>
                    <div class="dt-kv-val">${fore.eta?.formatted_duration || '—'}</div>
                </div>
                <div class="dt-kv-box">
                    <div class="dt-kv-lbl">Distance Remaining</div>
                    <div class="dt-kv-val">${fore.distance?.to_port_km} km</div>
                </div>
                <div class="dt-kv-box">
                    <div class="dt-kv-lbl">Emergency Prob.</div>
                    <div class="dt-kv-val ${fore.emergencyProbability >= 50 ? 'red' : 'green'}">${fore.emergencyProbability}%</div>
                </div>
            </div>
            <div class="dt-kv-box" style="margin-bottom:8px;">
                <div class="dt-kv-lbl" style="margin-bottom:4px;">Predicted Weather</div>
                <div class="dt-grid-3">
                    <div style="text-align:center;"><div style="font-size:8.5px;color:#64748b;">Wave</div><div class="dt-kv-val cyan">${fore.weather?.wave_height}m</div></div>
                    <div style="text-align:center;"><div style="font-size:8.5px;color:#64748b;">Wind</div><div class="dt-kv-val amber">${fore.weather?.wind_speed} km/h</div></div>
                    <div style="text-align:center;"><div style="font-size:8.5px;color:#64748b;">Current</div><div class="dt-kv-val">${fore.weather?.ocean_current} kn</div></div>
                </div>
                <div style="margin-top:5px;font-size:9px;text-align:center;color:${fwCol};font-weight:700;">${(fore.weather?.severity || 'SAFE').toUpperCase()} CONDITIONS PREDICTED</div>
            </div>
            <div class="dt-grid-2">
                <div class="dt-kv-box">
                    <div class="dt-kv-lbl">Predicted Safety</div>
                    <div class="dt-kv-val" style="color:${_safetyColor(fore.safetyScore)};">${fore.safetyScore}/100</div>
                </div>
                <div class="dt-kv-box">
                    <div class="dt-kv-lbl">AI Confidence</div>
                    <div class="dt-kv-val green">${fore.confidence}%</div>
                </div>
            </div>
            ${mission.portChanged ? `
            <div class="port-switch-banner" style="margin-top:8px;">
                🔄 <strong>Port Changed!</strong> ${mission.portChangeReason}
            </div>` : ''}
        </div>

        <!-- 24h Risk Trend Chart -->
        <div id="dtRiskTrendChart" style="padding:8px;background:rgba(0,0,0,0.2);border-radius:8px;border:1px solid #1e3a5f;margin-bottom:8px;overflow:hidden;min-height:50px;"></div>

        `;

        _bindSliderEvents();
        _renderRiskTrendChart();
    }

    function _renderRecommendedPort(curr, fore, mission) {
        const el = document.getElementById('dtSec5');
        if (!el) return;

        const port = curr.selectedPort || fore.selectedPort;
        const ed   = _emergencyData || window.emergencyCache;
        const routeData = ed || { safety_score: curr.safetyScore, eta: curr.eta, sea_route_distance_km: curr.distance?.to_port_km, sea_route_distance_nm: curr.route?.distance_nm, fuel_tons: ((curr.distance?.to_port_km || 0) * 0.08).toFixed(1) };

        el.innerHTML = `
        <div id="dtPortCardWrap">
            ${_renderPortCard(port, true, routeData, curr.weather)}
        </div>`;

        _wireJourneyButton();
    }

    function _renderTimeline(mission) {
        const el = document.getElementById('dtSec6');
        if (!el) return;

        const events = mission.timeline || [];
        el.innerHTML = `
        <div class="dt-card" style="padding:10px;">
            <ul class="dt-timeline" id="dtTimelineList">
                ${events.map(e => `
                <li class="dt-tl-item">
                    <div class="dt-tl-dot dot-${e.type || 'info'}"></div>
                    <div>
                        <div class="dt-tl-time">${e.ts}</div>
                        <div class="dt-tl-text">${e.description}</div>
                    </div>
                </li>`).join('')}
            </ul>
        </div>`;
    }

    function _renderTop5Ports(curr) {
        const el = document.getElementById('dtSec7');
        if (!el) return;

        const candidates = curr.candidatePorts || [];
        if (candidates.length === 0) {
            el.innerHTML = `<div style="color:#475569;font-size:10px;text-align:center;padding:8px;">Candidate ports loading...</div>`;
            return;
        }

        const top5 = candidates.slice(0, 5);
        const ed   = _emergencyData || window.emergencyCache;

        el.innerHTML = top5.map((port, i) => {
            const isRec = (i === 0) || (ed && String(ed.selected_port?.id) === String(port.id));
            const weather = curr.weather || {};
            // Build synthetic route data from port score breakdown
            const sb = port.score_breakdown || {};
            const routeData = {
                safety_score: Math.round(100 - (port.port_score / 10)),
                sea_route_distance_km: port.distance_km,
                sea_route_distance_nm: port.distance_nm,
                eta: { formatted_duration: sb.eta_hours ? `${sb.eta_hours.toFixed(1)}h` : '--' },
                fuel_tons: ((port.distance_km || 0) * 0.08).toFixed(1)
            };
            return `<div style="font-size:9px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;">#${i+1} CANDIDATE</div>
                    ${_renderPortCard(port, isRec, routeData, weather)}`;
        }).join('');
    }

    // ── Event Binding ─────────────────────────────────────────────────────────

    function _bindSliderEvents() {
        const slider = document.getElementById('dtSlider');
        if (!slider) return;

        slider.addEventListener('input', (e) => {
            const step    = parseInt(e.target.value);
            const offMin  = OFFSETS[Math.min(step, OFFSETS.length - 1)];
            const pct     = (step / (OFFSETS.length - 1)) * 100;
            slider.style.setProperty('--pct', pct + '%');
            _userSelectedOffset = offMin;
            _currentOffset = offMin;

            clearTimeout(_debounceTimer);

            // Instant from cache
            const cached = window.missionCache[String(offMin)];
            if (cached) {
                window.currentMission = cached;
                renderFromMission(cached, offMin);
            } else if (window.MissionEngine?.fetchOffset) {
                _debounceTimer = setTimeout(() => {
                    showLoading();
                    window.MissionEngine.fetchOffset(offMin).then(m => {
                        hideLoading();
                        if (m) renderFromMission(m, offMin);
                    });
                }, 150);
            }
        });

        const clamp = (v) => Math.max(0, Math.min(OFFSETS.length - 1, v));
        const snap  = (v) => OFFSETS[v];
        const cur   = () => Math.max(0, OFFSETS.indexOf(_snapOffset(_currentOffset)));

        const go = (newStep) => {
            const offMin = snap(clamp(newStep));
            _userSelectedOffset = offMin;
            _currentOffset = offMin;
            const cached = window.missionCache[String(offMin)];
            if (cached) {
                window.currentMission = cached;
                renderFromMission(cached, offMin);
            } else if (window.MissionEngine?.fetchOffset) {
                showLoading();
                window.MissionEngine.fetchOffset(offMin).then(m => {
                    hideLoading();
                    if (m) renderFromMission(m, offMin);
                });
            } else if (window.MissionEngine) {
                const m = window.MissionEngine.getMission(offMin);
                if (m) renderFromMission(m, offMin);
            }
        };

        document.getElementById('btnM30')?.addEventListener('click', () => go(cur() - 1));
        document.getElementById('btnP30')?.addEventListener('click', () => go(cur() + 1));
        document.getElementById('btnP1h')?.addEventListener('click', () => go(OFFSETS.indexOf(60)));
        document.getElementById('btnP2h')?.addEventListener('click', () => go(OFFSETS.indexOf(120)));
        document.getElementById('btnP4h')?.addEventListener('click', () => go(OFFSETS.indexOf(240)));
        document.getElementById('btnP6h')?.addEventListener('click', () => go(OFFSETS.indexOf(360)));
        document.getElementById('btnP12h')?.addEventListener('click', () => go(OFFSETS.indexOf(720)));
        document.getElementById('btnRst')?.addEventListener('click', () => go(0));
    }

    // ── Map Update ────────────────────────────────────────────────────────────

    function _updateMap(fore) {
        if (!fore || !_map) return;

        // CRITICAL FIX: Do NOT snap ship marker to static forecast position when vessel is animating or in live T=0 mode
        if (window.MaritimeAnimation?.isAnimating()) return;
        if (_currentOffset === 0) return;

        // Move Simulation Ship to forecast position ONLY if time slider is moved to a future offset
        if (fore.ship && window.SimulationShip?.setSimPosition) {
            window.SimulationShip.setSimPosition(
                fore.ship.lat,
                fore.ship.lon,
                fore.ship.heading
            );
        }
    }

    // ── Panel Shell ───────────────────────────────────────────────────────────

    function _buildPanelShell() {
        let btn = document.getElementById('dtToggleBtn');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'dtToggleBtn';
            btn.title = 'Toggle AI Digital Twin Dashboard';
            btn.innerHTML = `<div class="dt-dot"></div><span>AI Digital Twin</span>`;
            btn.addEventListener('click', togglePanel);
            document.body.appendChild(btn);
        }

        if (document.getElementById('dtPanel')) return;

        const panel = document.createElement('div');
        panel.id = 'dtPanel';
        panel.className = 'dt-panel';
        panel.innerHTML = `
        <div class="dt-side-tab" id="dtSideTab" title="Toggle AI Digital Twin Panel">
            <span class="dt-side-tab-icon">🤖</span>
            <span class="dt-side-tab-text">DIGITAL TWIN</span>
        </div>
        <div class="dt-panel-header">
            <div class="dt-panel-title"><span>🤖</span> AI DIGITAL TWIN MISSION HUB</div>
            <div style="display:flex;align-items:center;gap:8px;">
                <div id="dtStatusDot" style="width:7px;height:7px;border-radius:50%;background:#334155;transition:background 0.3s;"></div>
                <span id="dtStatusLabel" style="font-size:8.5px;color:#64748b;font-family:'JetBrains Mono',monospace;">IDLE</span>
                <button class="dt-panel-close" id="dtPanelClose">✕</button>
            </div>
        </div>
        <div class="dt-panel-body">
            <div class="dt-loading-overlay" id="dtLoadingOverlay"><div class="dt-spinner"></div></div>

            <!-- Section 0: Emergency Mission Banner -->
            <div id="dtSecEmergency" style="display:none;"></div>

            <!-- Section 1: Current Mission -->
            <div class="dt-sec-hdr">
                <div class="dt-sec-title">📍 CURRENT MISSION STATUS</div>
                <span class="dt-sec-tag tag-current">LIVE T=0</span>
            </div>
            <div id="dtSec1"><div style="color:#475569;font-size:11px;text-align:center;padding:20px 0;">Place Simulation Ship to activate AI Digital Twin</div></div>

            <!-- Section 2: Risk Analysis -->
            <div class="dt-sec-hdr">
                <div class="dt-sec-title">🛡 AI RISK ANALYSIS</div>
            </div>
            <div id="dtSec2"></div>

            <!-- Section 3: Weather -->
            <div class="dt-sec-hdr">
                <div class="dt-sec-title">🌊 WEATHER INTELLIGENCE</div>
            </div>
            <div id="dtSec3"></div>

            <!-- Section 4: Prediction + Time Slider -->
            <div class="dt-sec-hdr">
                <div class="dt-sec-title">🔮 PREDICTION ENGINE</div>
                <span class="dt-sec-tag tag-future">FORECAST</span>
            </div>
            <div id="dtSec4"></div>

            <!-- Section 5: Recommended Port -->
            <div class="dt-sec-hdr">
                <div class="dt-sec-title">⚓ RECOMMENDED PORT</div>
                <span id="dtPortReadyBadge" style="font-size:8px;color:#475569;font-family:'JetBrains Mono',monospace;"></span>
            </div>
            <div id="dtSec5"></div>

            <!-- Section 6: Mission Timeline -->
            <div class="dt-sec-hdr">
                <div class="dt-sec-title">📋 MISSION TIMELINE</div>
            </div>
            <div id="dtSec6"></div>

            <!-- Section 7: Top-5 Candidate Ports -->
            <div class="dt-sec-hdr">
                <div class="dt-sec-title">🗺 TOP-5 CANDIDATE PORTS</div>
            </div>
            <div id="dtSec7"></div>
        </div>`;

        document.body.appendChild(panel);
        document.getElementById('dtPanelClose')?.addEventListener('click', hidePanel);
        document.getElementById('dtSideTab')?.addEventListener('click', togglePanel);

        // Background refresh every 10 minutes
        setInterval(() => {
            if (window.currentMission && window.MissionEngine) {
                const cached = window.missionCache[String(_snapOffset(_currentOffset))];
                if (cached) renderFromMission(cached, _currentOffset);
            }
        }, 600_000);
    }

    function showPanel() {
        const panel = document.getElementById('dtPanel');
        if (panel) panel.classList.add('visible');
        const dot = document.getElementById('dtToggleBtn')?.querySelector('.dt-dot');
        if (dot) dot.classList.add('active');
        _panelVisible = true;
        _setStatus('LIVE', '#10b981');
    }

    function hidePanel() {
        const panel = document.getElementById('dtPanel');
        if (panel) panel.classList.remove('visible');
        const dot = document.getElementById('dtToggleBtn')?.querySelector('.dt-dot');
        if (dot) dot.classList.remove('active');
        _panelVisible = false;
    }

    function togglePanel() {
        _panelVisible ? hidePanel() : showPanel();
    }

    function _setStatus(label, color) {
        const dot  = document.getElementById('dtStatusDot');
        const lbl  = document.getElementById('dtStatusLabel');
        if (dot) dot.style.background = color;
        if (lbl) lbl.textContent = label;

        const badgeDot = document.getElementById('dtToggleBtn')?.querySelector('.dt-dot');
        if (badgeDot) {
            badgeDot.style.background = color;
            badgeDot.style.boxShadow  = `0 0 8px ${color}99`;
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _snapOffset(minutes) {
        const sorted = OFFSETS;
        let best = sorted[0], bestDiff = Math.abs(minutes - sorted[0]);
        for (const v of sorted) {
            const diff = Math.abs(minutes - v);
            if (diff < bestDiff) { bestDiff = diff; best = v; }
        }
        return best;
    }

    function _headingLabel(hdg) {
        if (hdg === undefined || hdg === null) return '';
        const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
        return dirs[Math.round(hdg / 22.5) % 16];
    }

    // ── Public API ────────────────────────────────────────────────────────────

    function init(mapInstance) {
        _map = mapInstance;
        _buildPanelShell();
    }

    function onShipUpdate(ship) {
        if (!ship) return;
        _baseShip = { ...ship };
        _setStatus('CONNECTING...', '#f59e0b');
    }
    function showLoading() {
        const overlay = document.getElementById('dtLoadingOverlay');
        if (overlay) overlay.classList.add('active');
    }

    function hideLoading() {
        const overlay = document.getElementById('dtLoadingOverlay');
        if (overlay) overlay.classList.remove('active');
    }

    function _buildSyntheticMission(data, vesselName) {
        const sel = data.selected_port || {};
        const shipData = window.SimulationShip?.getData() || _baseShip || {};
        const state = {
            ship: {
                lat: shipData.lat || 0,
                lon: shipData.lon || shipData.lng || 0,
                heading: shipData.heading || 0,
                speed: shipData.speed || 15,
                fuel: shipData.fuel || 80
            },
            weather: data.weather_summary || { wave_height: 1.5, wind_speed: 20, severity: 'safe' },
            selectedPort: sel,
            candidatePorts: data.candidates || [sel],
            route: {
                coordinates: data.coordinates || [],
                distance_km: data.sea_route_distance_km || 0,
                distance_nm: data.sea_route_distance_nm || 0
            },
            eta: data.eta || { formatted_duration: '--' },
            distance: { moved_km: 0, to_port_km: data.sea_route_distance_km || 0 },
            fuel: { remaining_pct: shipData.fuel || 80, burned_pct: 0 },
            safetyScore: data.safety_score || 85,
            safetyRating: data.safety_rating || 'Good',
            riskBreakdown: { waveHeight: 5, windSpeed: 5, fuelLevel: 0, distanceToPort: 5, weatherSeverity: 0, nightNavigation: 0 }
        };

        return {
            shipName: vesselName || shipData.name || 'EMERGENCY VESSEL',
            current: state,
            forecast: state,
            timeline: [
                { ts: 'NOW', description: `🚨 Emergency Route active → ${sel.PORT_NAME} (${data.sea_route_distance_km} km)`, type: 'danger' }
            ]
        };
    }

    function onEmergencyRoute(data, vesselName) {
        _emergencyData = { ...data, _vesselName: vesselName };
        hideLoading();
        _renderEmergencySection();
        showPanel();

        if (window.currentMission) {
            renderFromMission(window.currentMission, _currentOffset);
        } else if (data.selected_port) {
            const syn = _buildSyntheticMission(data, vesselName);
            window.currentMission = syn;
            renderFromMission(syn, 0);
        }

        if (window.MissionEngine?.addEvent) {
            window.MissionEngine.addEvent('danger', `🚨 Emergency Route activated → ${data.selected_port?.PORT_NAME} (${data.sea_route_distance_km} km)`);
        }
    }

    function onEmergencyCacheReady(data) {
        _emergencyData = data;
        _renderEmergencySection();
        const badge = document.getElementById('dtPortReadyBadge');
        if (badge) badge.textContent = '⚡ INSTANT READY';
    }

    // Expose API methods
    const TimeSim_exports = {
        init,
        onShipUpdate,
        onEmergencyRoute,
        onEmergencyCacheReady,
        renderFromMission,
        updateLiveTelemetry,
        getEmergencyData: () => _emergencyData,
        buildRiskTrend,
        refreshTimeline,
        showPanel,
        hidePanel,
        togglePanel,
        showLoading,
        hideLoading,
        get _currentOffset() { return _currentOffset; }
    };

    if (typeof window !== 'undefined') window.TimeSim = TimeSim_exports;
    return TimeSim_exports;

})();
