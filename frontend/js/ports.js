/**
 * Maritime Emergency Response System - World Ports Module (Optimized)
 * =====================================================================
 */

const MaritimePorts = (function () {
    'use strict';

    let _map = null;
    let _cluster = null;
    let _portsData = [];
    let _loaded = false;
    let _visible = false;
    let _loadedMarkersCount = 0;
    let _isInitialized = false;

    let _toggleBtn = null;
    let _statusPill = null;
    let _countBadge = null;

    let _anchorIcon = null;
    function _getAnchorIcon() {
        if (_anchorIcon) return _anchorIcon;
        _anchorIcon = L.divIcon({
            className: '',
            html: `<div style="
                width:22px;height:32px;
                display:flex;flex-direction:column;align-items:center;
                filter:drop-shadow(0 2px 4px rgba(239,68,68,0.55));">
                <svg width="22" height="28" viewBox="0 0 40 50" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="20" cy="16" r="14" fill="#ef4444" stroke="#fff" stroke-width="2"/>
                    <g transform="translate(11,8) scale(0.9)" stroke="#fff" stroke-width="2.2" stroke-linecap="round" fill="none">
                        <circle cx="10" cy="4" r="2.5"/>
                        <line x1="10" y1="6.5" x2="10" y2="17"/>
                        <line x1="6" y1="9" x2="14" y2="9"/>
                        <path d="M4 13.5 C4 17.5 7.5 19.5 10 19.5 C12.5 19.5 16 17.5 16 13.5"/>
                        <line x1="2.5" y1="12" x2="5.5" y2="15"/>
                        <line x1="14.5" y1="12" x2="17.5" y2="15"/>
                    </g>
                    <polygon points="17,28 20,36 23,28" fill="#ef4444" stroke="#fff" stroke-width="1"/>
                </svg>
            </div>`,
            iconSize: [22, 32],
            iconAnchor: [11, 32],
            popupAnchor: [0, -34]
        });
        return _anchorIcon;
    }

    function _makeMarker(port) {
        const m = L.marker([parseFloat(port.LATITUDE), parseFloat(port.LONGITUDE)], {
            icon: _getAnchorIcon(),
            title: port.PORT_NAME,
            interactive: true
        });

        m.bindPopup(() => _buildPopup(port), {
            maxWidth: 240,
            className: 'port-popup'
        });

        return m;
    }

    function _buildPopup(p) {
        const name    = p.PORT_NAME    || 'Unknown Port';
        const country = p.COUNTRY      || 'N/A';
        const hType   = p.HARBORTYPE   || 'Unspecified';
        const hSize   = p.HARBORSIZE   || 'Unspecified';
        const lat     = parseFloat(p.LATITUDE).toFixed(4);
        const lon     = parseFloat(p.LONGITUDE).toFixed(4);
        const fuel    = (p.FUEL_OIL === 'Y' || p.DIESEL === 'Y') ? '✅ Available' : '❌ None';
        const repair  = (p.ELECREPAIR === 'Y' || p.REPAIRCODE)   ? '✅ Available' : '❌ None';
        const medical = (p.MED_FACIL  === 'Y')                   ? '✅ Available' : '❌ None';

        return `
            <div class="maritime-popup">
                <div class="popup-header-tag port-tag">⚓ World Port</div>
                <div class="popup-item-title">${name} (${country})</div>
                <div class="popup-info-grid">
                    <div class="info-row"><span class="info-label">Harbor Type :</span><span class="info-val">${hType}</span></div>
                    <div class="info-row"><span class="info-label">Harbor Size :</span><span class="info-val">${hSize}</span></div>
                    <div class="info-row"><span class="info-label">Latitude :</span><span class="mono-val">${lat}</span></div>
                    <div class="info-row"><span class="info-label">Longitude :</span><span class="mono-val">${lon}</span></div>
                    <div class="info-row"><span class="info-label">Fuel Supply :</span><span class="info-val">${fuel}</span></div>
                    <div class="info-row"><span class="info-label">Repairs :</span><span class="info-val">${repair}</span></div>
                    <div class="info-row"><span class="info-label">Medical :</span><span class="info-val">${medical}</span></div>
                </div>
            </div>
        `;
    }

    async function _loadOnce() {
        if (_loaded) return;
        try {
            const res  = await fetch('/ports');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            _portsData = await res.json();
            _loaded    = true;

            const markers = _portsData
                .filter(p => p.LATITUDE != null && p.LONGITUDE != null)
                .map(_makeMarker);

            _cluster.addLayers(markers);
            _loadedMarkersCount = markers.length;
            if (_countBadge) _countBadge.textContent = `(${_portsData.length.toLocaleString()})`;

            console.log("Ports loaded markers count:", _loadedMarkersCount);

            // Sync map layer state after async load
            if (_visible) {
                if (_map && !_map.hasLayer(_cluster)) _map.addLayer(_cluster);
            } else {
                if (_map && _map.hasLayer(_cluster)) _map.removeLayer(_cluster);
            }
        } catch (err) {
            console.error('Ports load error:', err);
        }
    }

    function setPortsVisible(show) {
        console.log("setPortsVisible:", show);
        console.log("Before map.hasLayer(portCluster):", _map ? _map.hasLayer(_cluster) : false);

        _visible = !!show;
        if (!_map || !_cluster) return;

        if (_visible) {
            if (!_loaded) _loadOnce();
            if (!_map.hasLayer(_cluster)) {
                _map.addLayer(_cluster);
            }
            _toggleBtn?.classList.replace('port-btn-off', 'port-btn-on');
            if (_statusPill) _statusPill.textContent = 'ON';
        } else {
            if (_map.hasLayer(_cluster)) {
                _map.removeLayer(_cluster);
            }
            _toggleBtn?.classList.replace('port-btn-on', 'port-btn-off');
            if (_statusPill) _statusPill.textContent = 'OFF';
        }

        console.log("After map.hasLayer(portCluster):", _map ? _map.hasLayer(_cluster) : false);
    }

    function init(mapInstance) {
        _map = mapInstance || window.MaritimeMap?.getMap();
        if (!_map) return;

        _countBadge  = document.getElementById('portCount');
        _toggleBtn   = document.getElementById('togglePortsBtn');
        _statusPill  = document.getElementById('portToggleStatus');

        if (_toggleBtn) {
            _toggleBtn.addEventListener('click', () => {
                setPortsVisible(!_visible);
            });
        }

        if (!_cluster) {
            _cluster = L.markerClusterGroup({
                chunkedLoading: true,
                chunkInterval: 50,
                chunkDelay: 20,
                maxClusterRadius: 40,
                disableClusteringAtZoom: 10,
                spiderfyOnMaxZoom: true,
                showCoverageOnHover: false,
                zoomToBoundsOnClick: true,
                renderer: L.canvas({ padding: 0.5 })
            });
        }

        _isInitialized = true;
        console.log("Ports initialized");
        console.log("portCluster:", _cluster);
        console.log("portMarkers.length:", _loadedMarkersCount);

        _loadOnce();
    }

    function getClusterGroup() { return _cluster; }
    function getPortCount() { return _loadedMarkersCount; }
    function ready() { return _isInitialized; }

    return {
        init: init,
        getClusterGroup: getClusterGroup,
        getPortCount: getPortCount,
        togglePorts: () => setPortsVisible(!_visible),
        setPortsVisible: setPortsVisible,
        loadPorts: _loadOnce,
        ready: ready
    };
})();
