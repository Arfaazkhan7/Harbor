/**
 * Maritime Emergency Response System - World Map Module
 * ======================================================
 * Manages core Leaflet map initialization, tile layers,
 * responsive sizing, and interactive coordinate inspection panel.
 */

const MaritimeMap = (function () {
    'use strict';

    // Configuration Constants
    const CONFIG = {
        initialCenter: [20.0, 15.0],
        initialZoom: 2.5,
        minZoom: 2,
        maxZoom: 19,
        tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        tileAttribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
        decimalPlaces: 6
    };

    // Private Module State
    let map = null;
    let activeClickMarker = null;

    // DOM Element Caches
    let latValueElem = null;
    let lngValueElem = null;
    let panelStatusElem = null;

    /**
     * Helper to format numerical coordinate value to 6 decimal places.
     */
    function formatCoord(value) {
        return (value !== null && value !== undefined) ? Number(value).toFixed(CONFIG.decimalPlaces) : 'N/A';
    }

    /**
     * Handle map click event for coordinate inspection panel
     */
    function onMapClick(event) {
        const rawLat = event.latlng.lat;
        const rawLng = L.Util.wrapNum(event.latlng.lng, [-180, 180], true);

        const formattedLat = formatCoord(rawLat);
        const formattedLng = formatCoord(rawLng);

        if (latValueElem) latValueElem.textContent = formattedLat;
        if (lngValueElem) lngValueElem.textContent = formattedLng;
        if (panelStatusElem) panelStatusElem.textContent = 'Active coordinate selected';

        if (activeClickMarker) {
            map.removeLayer(activeClickMarker);
            activeClickMarker = null;
        }

        activeClickMarker = L.marker([rawLat, rawLng], {
            icon: L.divIcon({
                className: 'custom-click-marker',
                html: `<div class="marker-pin-outer"><div class="marker-pin-inner"></div></div>`,
                iconSize: [24, 24],
                iconAnchor: [12, 12],
                popupAnchor: [0, -14]
            })
        }).addTo(map);

        const popupContent = `
            <div class="coordinate-popup">
                <div class="popup-title">Selected Coordinate</div>
                <div class="popup-coord"><strong>Latitude :</strong> <span class="popup-val">${formattedLat}</span></div>
                <div class="popup-coord"><strong>Longitude :</strong> <span class="popup-val">${formattedLng}</span></div>
            </div>
        `;

        activeClickMarker.bindPopup(popupContent).openPopup();
    }

    /**
     * Initialize Leaflet map instance
     */
    function initMap(containerId = 'map') {
        const container = document.getElementById(containerId);
        if (!container) {
            console.error(`Map container '#${containerId}' not found.`);
            return null;
        }

        latValueElem = document.getElementById('latValue');
        lngValueElem = document.getElementById('lngValue');
        panelStatusElem = document.getElementById('panelStatus');

        map = L.map(containerId, {
            center: CONFIG.initialCenter,
            zoom: CONFIG.initialZoom,
            minZoom: CONFIG.minZoom,
            maxZoom: CONFIG.maxZoom,
            zoomControl: false,
            worldCopyJump: false,           // Prevent map from jumping to duplicate worlds
            attributionControl: true,
            // Lock map to a single world copy — prevents infinite horizontal scrolling
            maxBounds: [[-90, -180], [90, 180]],
            maxBoundsViscosity: 1.0         // Rubber-band snapping at world edges (1.0 = hard stop)
        });

        L.control.zoom({ position: 'bottomright' }).addTo(map);

        L.tileLayer(CONFIG.tileUrl, {
            maxZoom: CONFIG.maxZoom,
            attribution: CONFIG.tileAttribution,
            noWrap: true                    // Prevent tile layer from rendering beyond ±180°
        }).addTo(map);

        map.on('click', onMapClick);
        window.addEventListener('resize', () => map && map.invalidateSize());

        console.log('Leaflet Map initialized successfully.');
        return map;
    }

    /**
     * Get the active map instance.
     */
    function getMap() {
        return map;
    }

    return {
        init: initMap,
        getMap: getMap,
        formatCoord: formatCoord
    };
})();
