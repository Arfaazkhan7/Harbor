/**
 * Maritime Emergency Response System — Weather Engine Frontend Module
 * ===================================================================
 * Visualizes Open-Meteo Marine API weather sample points along sea routes.
 */

const MaritimeWeather = (function () {
    'use strict';

    let _map = null;
    let _weatherLayerGroup = null;

    /** Get status badge HTML */
    function getStatusBadge(status) {
        const s = (status || '').toLowerCase();
        let bg = '#10b981', label = 'Safe';
        if (s === 'moderate') { bg = '#eab308'; label = 'Moderate'; }
        else if (s === 'rough') { bg = '#f97316'; label = 'Rough'; }
        else if (s === 'danger') { bg = '#ef4444'; label = 'Danger'; }
        return `<span style="background:${bg}; color:#fff; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:600; text-transform:uppercase;">${label}</span>`;
    }

    /** Create custom map marker icon for weather point */
    function createWeatherIcon(point) {
        const s = (point.point_status || 'safe').toLowerCase();
        let color = '#10b981', border = '#047857';
        if (s === 'moderate') { color = '#eab308'; border = '#b45309'; }
        else if (s === 'rough') { color = '#f97316'; border = '#c2410c'; }
        else if (s === 'danger') { color = '#ef4444'; border = '#b91c1c'; }

        return L.divIcon({
            className: 'weather-sample-icon',
            html: `<div style="
                width: 14px;
                height: 14px;
                background-color: ${color};
                border: 2px solid ${border};
                border-radius: 50%;
                box-shadow: 0 0 6px ${color};
                cursor: pointer;
                transition: transform 0.2s ease;
            " title="Sample #${point.index} (${point.distance_km} km) — ${point.wave_height}m wave, ${point.wind_speed}km/h wind"></div>`,
            iconSize: [14, 14],
            iconAnchor: [7, 7]
        });
    }

    /** Render all 25km sampled weather points on Leaflet map */
    function renderWeatherPoints(mapInstance, sampledPoints) {
        _map = mapInstance || _map;
        if (!_map) return;

        clearWeatherPoints();

        _weatherLayerGroup = L.layerGroup().addTo(_map);

        (sampledPoints || []).forEach(pt => {
            const marker = L.marker([pt.lat, pt.lon], {
                icon: createWeatherIcon(pt),
                zIndexOffset: 500
            });

            const popupContent = `
                <div class="weather-popup" style="font-family: 'Inter', sans-serif; min-width: 210px; padding: 4px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #e2e8f0; padding-bottom:6px; margin-bottom:8px;">
                        <strong style="color:#0f172a; font-size:13px;">📍 Sample #${pt.index} (${pt.distance_km} km)</strong>
                        ${getStatusBadge(pt.point_status)}
                    </div>
                    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px; font-size:11px;">
                        <div style="background:#f8fafc; padding:6px; border-radius:6px;">
                            <div style="color:#64748b; font-size:10px;">🌊 Wave Height</div>
                            <strong style="color:#0f172a; font-size:12px;">${pt.wave_height} m</strong>
                        </div>
                        <div style="background:#f8fafc; padding:6px; border-radius:6px;">
                            <div style="color:#64748b; font-size:10px;">⏱️ Wave Period</div>
                            <strong style="color:#0f172a; font-size:12px;">${pt.wave_period} s (${pt.wave_direction}°)</strong>
                        </div>
                        <div style="background:#f8fafc; padding:6px; border-radius:6px;">
                            <div style="color:#64748b; font-size:10px;">💨 Wind Speed</div>
                            <strong style="color:#0f172a; font-size:12px;">${pt.wind_speed} km/h</strong>
                        </div>
                        <div style="background:#f8fafc; padding:6px; border-radius:6px;">
                            <div style="color:#64748b; font-size:10px;">🧭 Current</div>
                            <strong style="color:#0f172a; font-size:12px;">${pt.ocean_current_velocity} km/h (${pt.ocean_current_direction}°)</strong>
                        </div>
                    </div>
                    <div style="margin-top:6px; font-size:10px; color:#94a3b8; text-align:right;">
                        Open-Meteo Marine API
                    </div>
                </div>
            `;

            marker.bindPopup(popupContent, { maxWidth: 260 });
            _weatherLayerGroup.addLayer(marker);
        });
    }

    /** Clear weather markers layer */
    function clearWeatherPoints() {
        if (_weatherLayerGroup && _map) {
            _map.removeLayer(_weatherLayerGroup);
            _weatherLayerGroup = null;
        }
    }

    return {
        init: (map) => { _map = map; },
        renderWeatherPoints,
        clearWeatherPoints
    };
})();
