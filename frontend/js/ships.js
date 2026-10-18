/**
 * Maritime Emergency Response System — Ocean Ships Module
 * =========================================================
 * Fetches EXACTLY 200 GIS-verified ocean ships from /ships endpoint
 * and places them on the Leaflet map.
 */

const MaritimeShips = (function () {
    'use strict';

    let map = null;
    let clusterGroup = null;
    let isVisible = false;
    let shipCountElem = null;
    let loadedMarkersCount = 0;
    let isInitialized = false;

    function createShipIcon(heading) {
        const rotate = (typeof heading === 'number' && heading >= 0 && heading < 360) ? heading : 0;
        return L.divIcon({
            className: 'custom-standalone-ship-icon',
            html: `
                <div class="standalone-ship-wrapper">
                    <div class="ship-rotator" style="transform:rotate(${rotate}deg);">
                        <svg width="32" height="24" viewBox="0 0 32 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <rect x="13" y="1" width="1.8" height="6" fill="#0f172a"/>
                            <rect x="11.5" y="3" width="4.8" height="1.5" fill="#0f172a"/>
                            <path d="M11.5 5.5H16.5L15.5 8.5H12.5L11.5 5.5Z" fill="#38bdf8" stroke="#0f172a" stroke-width="0.8"/>
                            <path d="M9.5 8.5H17.5L20.5 12H7.5L9.5 8.5Z" fill="#e2e8f0" stroke="#0f172a" stroke-width="1.2" stroke-linejoin="round"/>
                            <rect x="11.5" y="9.8" width="2" height="1.6" rx="0.3" fill="#0f172a"/>
                            <rect x="14.5" y="9.8" width="2" height="1.6" rx="0.3" fill="#0f172a"/>
                            <path d="M4 12H7.5L9.5 13.5H22.5L27.5 13.5C28 13.5 28.5 14 28 14.5L25.5 19H4.5C3.5 19 3 18.2 3 17.5L3.5 14C3.6 12.8 3.8 12 4 12Z" fill="#0284c7" stroke="#0f172a" stroke-width="1.5" stroke-linejoin="round"/>
                            <line x1="5" y1="16.2" x2="19" y2="16.2" stroke="#38bdf8" stroke-width="1.2" stroke-linecap="round"/>
                        </svg>
                    </div>
                </div>`,
            iconSize: [32, 24],
            iconAnchor: [16, 12],
            popupAnchor: [0, -14]
        });
    }

    function buildPopup(ship) {
        const fmt = MaritimeMap.formatCoord;
        const v = (x, unit) => (x !== null && x !== undefined) ? `${x}${unit || ''}` : 'N/A';
        return `
            <div class="maritime-popup">
                <div class="popup-header-tag ship-tag">🚢 Ocean Vessel</div>
                <div class="popup-item-title">${ship.VesselName || 'Unknown Vessel'}</div>
                <div class="popup-info-grid">
                    <div class="info-row"><span class="info-label">MMSI :</span><span class="mono-val">${ship.MMSI || 'N/A'}</span></div>
                    <div class="info-row"><span class="info-label">Latitude :</span><span class="mono-val">${fmt(ship.LAT)}</span></div>
                    <div class="info-row"><span class="info-label">Longitude :</span><span class="mono-val">${fmt(ship.LON)}</span></div>
                    <div class="info-row"><span class="info-label">Speed :</span><span class="info-val">${v(ship.SOG, ' kn')}</span></div>
                    <div class="info-row"><span class="info-label">Course :</span><span class="info-val">${v(ship.COG, '°')}</span></div>
                    <div class="info-row"><span class="info-label">Heading :</span><span class="info-val">${v(ship.Heading, '°')}</span></div>
                    <div class="info-row"><span class="info-label">Timestamp :</span><span class="info-val">${ship.BaseDateTime || 'N/A'}</span></div>
                    <div class="info-row"><span class="info-label">IMO :</span><span class="mono-val">${ship.IMO || 'N/A'}</span></div>
                    <div class="info-row"><span class="info-label">Type :</span><span class="info-val">${ship.VesselType || 'Unspecified'}</span></div>
                    <div class="info-row"><span class="info-label">Status :</span><span class="info-val status-active">${ship.Status || 'Underway'}</span></div>
                </div>
            </div>`;
    }

    async function loadShips() {
        if (!map || !clusterGroup) return;

        try {
            const response = await fetch('/ships');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const ships = await response.json();

            clusterGroup.clearLayers();

            const seen = new Set();
            const markers = [];

            ships.forEach(ship => {
                if (!ship.LAT || !ship.LON || !ship.MMSI) return;
                const mmsi = String(ship.MMSI);
                if (seen.has(mmsi)) return;
                seen.add(mmsi);

                const marker = L.marker([ship.LAT, ship.LON], {
                    icon: createShipIcon(ship.Heading),
                    title: ship.VesselName || `MMSI ${mmsi}`
                });
                marker.bindPopup(buildPopup(ship));
                markers.push(marker);
            });

            clusterGroup.addLayers(markers);
            loadedMarkersCount = markers.length;
            if (shipCountElem) shipCountElem.textContent = markers.length;

            console.log("Ships loaded markers count:", loadedMarkersCount);

            // Sync map layer state after async fetch
            if (isVisible) {
                if (map && !map.hasLayer(clusterGroup)) map.addLayer(clusterGroup);
            } else {
                if (map && map.hasLayer(clusterGroup)) map.removeLayer(clusterGroup);
            }

        } catch (err) {
            console.error('Failed to load ocean ships:', err);
        }
    }

    function init(mapInstance) {
        map = mapInstance || MaritimeMap.getMap();
        if (!map) return;

        shipCountElem = document.getElementById('shipCount');

        if (!clusterGroup) {
            clusterGroup = L.markerClusterGroup({
                chunkedLoading: true,
                maxClusterRadius: 40,
                spiderfyOnMaxZoom: true,
                showCoverageOnHover: false,
                zoomToBoundsOnClick: true,
                disableClusteringAtZoom: 14
            });
        }

        isInitialized = true;
        console.log("Ships initialized");
        console.log("shipCluster:", clusterGroup);
        console.log("shipMarkers.length:", loadedMarkersCount);

        loadShips();
    }

    function setShipsVisible(show) {
        console.log("setShipsVisible:", show);
        console.log("Before map.hasLayer(shipCluster):", map ? map.hasLayer(clusterGroup) : false);

        isVisible = !!show;
        if (!map || !clusterGroup) return;

        if (isVisible) {
            if (!map.hasLayer(clusterGroup)) {
                map.addLayer(clusterGroup);
            }
        } else {
            if (map.hasLayer(clusterGroup)) {
                map.removeLayer(clusterGroup);
            }
        }

        console.log("After map.hasLayer(shipCluster):", map ? map.hasLayer(clusterGroup) : false);
    }

    function getClusterGroup() { return clusterGroup; }
    function getShipCount() { return loadedMarkersCount; }
    function ready() { return isInitialized; }

    return {
        init: init,
        getClusterGroup: getClusterGroup,
        getShipCount: getShipCount,
        setShipsVisible: setShipsVisible,
        showShips: () => setShipsVisible(true),
        hideShips: () => setShipsVisible(false),
        ready: ready
    };
})();
