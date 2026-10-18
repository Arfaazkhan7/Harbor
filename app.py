"""
Maritime Emergency Response System - Backend Server
====================================================
Flask REST API serving:
  - GET /ships : Exactly 200 GIS-verified ocean ships from `ocean_ships` table
  - GET /ports : All world ports from `ports` table
  - GET /api/* : Emergency, Journey, Alert log endpoints
"""

import os
import sqlite3
import logging
from flask import Flask, jsonify, send_from_directory

from backend.database import (
    init_db,
    log_emergency, get_emergency_logs,
    log_journey,   get_journey_logs,
    log_alert,     get_alert_logs,
    DB_PATH
)
from backend.route_engine import calculate_sea_route, haversine_km
from backend.weather_engine import fetch_marine_weather_for_route
from backend.route_score import analyze_route_safety
from backend.eta_engine import calculate_eta
from backend.emergency_router import find_best_emergency_port
from backend.mission_engine import evaluate_mission, prewarm_mission
from flask import request

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("App")

app = Flask(__name__, static_folder='frontend', static_url_path='')
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0  # Disable static file caching

# ─── Static File Serving ─────────────────────────────────────────────────────

@app.route('/')
def serve_index():
    response = send_from_directory('frontend', 'index.html')
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response


@app.route('/<path:path>')
def serve_static(path):
    response = send_from_directory('frontend', path)
    # Force no-cache for JS and CSS files to prevent stale versions being served
    if path.endswith('.js') or path.endswith('.css'):
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
        # Remove ETag so browser cannot use conditional 304 requests
        response.headers.pop('ETag', None)
        response.headers.pop('Last-Modified', None)
    return response


# ─── Ships Endpoint ───────────────────────────────────────────────────────────

@app.route('/ships', methods=['GET'])
def fetch_ships():
    """
    GET /ships
    Returns exactly 200 GIS-verified ocean ships from the `ocean_ships` table.
    All coordinates are 100% original AIS positions — never moved.
    Ships were pre-filtered using Natural Earth land polygons (GeoPandas/Shapely).
    """
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM ocean_ships ORDER BY id ASC")
        rows = cursor.fetchall()
        conn.close()
        return jsonify([dict(row) for row in rows])
    except Exception as e:
        logger.error(f"/ships error: {e}")
        return jsonify({'error': str(e)}), 500


# ─── Ports Endpoint ───────────────────────────────────────────────────────────

@app.route('/ports', methods=['GET'])
def fetch_ports():
    """
    GET /ports
    Returns all world ports from the `ports` table in maritime.db.
    """
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("""
            SELECT id, INDEX_NO, PORT_NAME, COUNTRY, LATITUDE, LONGITUDE,
                   HARBORTYPE, HARBORSIZE, FUEL_OIL, DIESEL, ELECREPAIR,
                   REPAIRCODE, MED_FACIL
            FROM ports
            WHERE LATITUDE IS NOT NULL AND LONGITUDE IS NOT NULL
              AND NOT (ABS(LATITUDE) < 0.01 AND ABS(LONGITUDE) < 0.01)
        """)
        rows = cursor.fetchall()
        conn.close()
        return jsonify([dict(row) for row in rows])
    except Exception as e:
        logger.error(f"/ports error: {e}")
        return jsonify({'error': str(e)}), 500


# ─── Log Endpoints ────────────────────────────────────────────────────────────

@app.route('/api/emergency', methods=['GET', 'POST'])
def handle_emergency():
    try:
        if request.method == 'POST':
            return jsonify({'success': True, 'id': log_emergency(request.get_json() or {}, DB_PATH)}), 201
        return jsonify(get_emergency_logs(DB_PATH))
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/journey', methods=['GET', 'POST'])
def handle_journey():
    try:
        if request.method == 'POST':
            return jsonify({'success': True, 'id': log_journey(request.get_json() or {}, DB_PATH)}), 201
        return jsonify(get_journey_logs(DB_PATH))
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/alerts', methods=['GET', 'POST'])
def handle_alerts():
    try:
        if request.method == 'POST':
            return jsonify({'success': True, 'id': log_alert(request.get_json() or {}, DB_PATH)}), 201
        return jsonify(get_alert_logs(DB_PATH))
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ─── Mission Engine Central Endpoint ───────────────────────────────────────

@app.route('/api/mission_update', methods=['POST'])
def mission_update():
    """
    POST /api/mission_update
    Single Mission Engine endpoint.
    Calculates ship dead reckoning, Open-Meteo weather, weighted port scoring,
    and returns unified `currentMission` object containing `current` (T=0) and
    `forecast` (T=sim_offset_min) states.
    """
    try:
        payload = request.get_json() or {}
        res = evaluate_mission(payload)
        return jsonify(res)
    except Exception as e:
        logger.error(f"❌ /api/mission_update exception: {e}", exc_info=True)
        return jsonify({'error': str(e)}), 500


@app.route('/api/mission_prewarm', methods=['POST'])
def mission_prewarm_endpoint():
    """
    POST /api/mission_prewarm
    ==========================
    Background pre-warmer — fires immediately when simulation ship is created or moved.
    Runs 8 evaluate_mission() calls in parallel (T=0, +30m, +1h, +2h, +4h, +6h, +12h, +24h).
    Frontend stores the result in window.missionCache for instant emergency response.

    Body: same as /api/mission_update (ship, start_time_iso, current_port_id)
    Returns: { success, cache: { '0': {...}, '30': {...}, ... }, completed_offsets, failed_offsets }
    """
    try:
        payload = request.get_json() or {}
        logger.info(f"[PreWarm] Starting for ship: {payload.get('ship', {}).get('name', '?')}")
        result = prewarm_mission(payload)
        logger.info(f"[PreWarm] Done. Completed: {result.get('completed_offsets')}")
        return jsonify(result)
    except Exception as e:
        logger.error(f"❌ /api/mission_prewarm exception: {e}", exc_info=True)
        return jsonify({'error': str(e)}), 500


# ─── Marine Route & Weather Engine Endpoints ───────────────────────────────

@app.route('/api/emergency/nearest_ports', methods=['POST'])
@app.route('/api/emergency/nearest_port', methods=['POST'])
def find_nearest_ports():
    """
    Find top N nearest emergency ports in the ship's moving direction.
    Accepts optional 'heading' (0-360°). Ports outside ±90° of heading are excluded.
    Falls back to nearest-5 by distance if fewer than 5 directional ports exist.
    """
    try:
        data = request.get_json() or {}
        ship_lat  = float(data.get('ship_lat'))
        ship_lon  = float(data.get('ship_lon'))
        heading   = data.get('heading')          # None if not moving / not set
        limit     = int(data.get('limit', 5))

        BOX = 30.0  # ±30° ~ 3,300 km bounding box to cover open oceans
        lat_min, lat_max = ship_lat - BOX, ship_lat + BOX
        lon_min, lon_max = ship_lon - BOX, ship_lon + BOX

        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        cursor.execute("""
            SELECT id, INDEX_NO, PORT_NAME, COUNTRY, LATITUDE, LONGITUDE,
                   HARBORTYPE, HARBORSIZE, FUEL_OIL, DIESEL, ELECREPAIR, MED_FACIL
            FROM ports
            WHERE LATITUDE  BETWEEN ? AND ?
              AND LONGITUDE BETWEEN ? AND ?
              AND NOT (ABS(LATITUDE) < 0.01 AND ABS(LONGITUDE) < 0.01)
        """, (lat_min, lat_max, lon_min, lon_max))
        rows = cursor.fetchall()

        # Fallback: full scan if bounding box is too sparse
        if len(rows) < limit:
            cursor.execute("""
                SELECT id, INDEX_NO, PORT_NAME, COUNTRY, LATITUDE, LONGITUDE,
                       HARBORTYPE, HARBORSIZE, FUEL_OIL, DIESEL, ELECREPAIR, MED_FACIL
                FROM ports
                WHERE LATITUDE IS NOT NULL AND LONGITUDE IS NOT NULL
                  AND NOT (ABS(LATITUDE) < 0.01 AND ABS(LONGITUDE) < 0.01)
            """)
            rows = cursor.fetchall()

        conn.close()

        if not rows:
            return jsonify({'error': 'No ports found in database'}), 404

        def bearing_to(p_lat, p_lon):
            """Compass bearing from ship position to port (0-360°, 0=North)."""
            import math
            lat1 = math.radians(ship_lat)
            lat2 = math.radians(p_lat)
            dlon = math.radians(p_lon - ship_lon)
            x = math.sin(dlon) * math.cos(lat2)
            y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
            b = math.degrees(math.atan2(x, y))
            return (b + 360) % 360

        def angle_diff(a, b):
            """Smallest angular difference between two bearings (0-180°)."""
            d = abs(a - b) % 360
            return d if d <= 180 else 360 - d

        # Compute distance and bearing for every candidate port
        ports_with_dist = []
        for p in rows:
            p_lat = float(p['LATITUDE'])
            p_lon = float(p['LONGITUDE'])
            dist  = haversine_km(ship_lat, ship_lon, p_lat, p_lon)
            bear  = bearing_to(p_lat, p_lon)
            pd = dict(p)
            pd['distance_km']  = round(dist, 2)
            pd['distance_nm']  = round(dist * 0.539957, 2)
            pd['bearing_deg']  = round(bear, 1)
            ports_with_dist.append(pd)

        ports_with_dist.sort(key=lambda x: x['distance_km'])

        # Direction filter: prioritize ports within ±90° of ship heading
        if heading is not None and str(heading).strip() != '':
            heading = float(heading)
            forward = [p for p in ports_with_dist if angle_diff(p['bearing_deg'], heading) <= 90]
            backward = [p for p in ports_with_dist if angle_diff(p['bearing_deg'], heading) > 90]
            # Combine directional ports first, then fill remaining slots with nearest ports
            candidates = forward + backward
        else:
            candidates = ports_with_dist

        top_ports = candidates[:limit]

        logger.info(f"✔ Nearest Ports Found: {len(top_ports)} ports selected from candidate pool of {len(candidates)}")
        for idx, p in enumerate(top_ports):
            logger.info(f"   #{idx+1}: {p['PORT_NAME']} ({p['COUNTRY']}) - {p['distance_km']} km, bearing={p['bearing_deg']}°")

        return jsonify({
            'success': True,
            'ports': top_ports,
            'port': top_ports[0] if top_ports else None
        })

    except Exception as e:
        logger.error(f"❌ /api/emergency/nearest_ports exception: {e}", exc_info=True)
        return jsonify({'error': str(e)}), 500


@app.route('/api/route_analysis', methods=['POST'])
def analyze_route():
    """
    Complete Marine Route & Weather Engine endpoint.
    Accepts: { ship_lat, ship_lon, dest_lat, dest_lon, ship_speed }
    """
    try:
        data = request.get_json() or {}
        ship_lat = float(data.get('ship_lat'))
        ship_lon = float(data.get('ship_lon'))
        dest_lat = float(data.get('dest_lat'))
        dest_lon = float(data.get('dest_lon'))
        speed_knots = float(data.get('ship_speed', 15.0))

        logger.info(f"▶ Emergency Route Analysis Requested: ({ship_lat}, {ship_lon}) ➔ ({dest_lat}, {dest_lon}) at {speed_knots} knots")

        # STEP 1: Generate Sea Route & Sample Points (10km dense sampling)
        route_res = calculate_sea_route(ship_lat, ship_lon, dest_lat, dest_lon, sample_interval_km=10.0)

        if not route_res.get('success'):
            logger.error(f"❌ searoute failed: {route_res.get('error')}")
            return jsonify({'error': route_res.get('error', 'Sea route generation failed')}), 400

        sampled_points = route_res.get('sampled_points', [])
        coordinates = route_res.get('coordinates', [])
        total_dist_km = route_res.get('total_distance_km', 0.0)

        logger.info(f"✔ Sea Route Generated: {len(coordinates)} polyline coordinates, {total_dist_km} km total distance")

        # STEP 2 & 3: Sample Marine Weather along route via Open-Meteo Marine API
        try:
            weather_points = fetch_marine_weather_for_route(sampled_points)
            logger.info(f"✔ Marine Weather Retrieved: {len(weather_points)} sampled weather points")
        except Exception as w_err:
            logger.error(f"❌ Open-Meteo Weather API Error: {w_err}", exc_info=True)
            weather_points = sampled_points

        # STEP 4 & 5: Calculate Route Safety & Score (100 to 20)
        safety_analysis = analyze_route_safety(weather_points)
        logger.info(f"✔ Safety Score Calculated: {safety_analysis['safety_score']} ({safety_analysis['safety_rating']})")

        # STEP 6: Calculate ETA
        eta_info = calculate_eta(total_dist_km, speed_knots)
        logger.info(f"✔ ETA Calculated: {eta_info.get('formatted_duration')}")

        return jsonify({
            'success': True,
            'origin': {'lat': ship_lat, 'lon': ship_lon},
            'destination': {'lat': dest_lat, 'lon': dest_lon},
            'coordinates': coordinates,
            'sampled_weather': safety_analysis['analyzed_points'],
            'weather_summary': safety_analysis['summary'],
            'safety_score': safety_analysis['safety_score'],
            'safety_rating': safety_analysis['safety_rating'],
            'eta': eta_info
        })


    except Exception as e:
        logger.error(f"❌ /api/route_analysis exception: {e}", exc_info=True)
        return jsonify({'error': str(e)}), 500


# ─── Emergency Find Route (New — batch-scan, shortest valid sea route) ────────

@app.route('/api/emergency/find_route', methods=['POST'])
def emergency_find_route():
    """
    POST /api/emergency/find_route
    ================================
    Single-call endpoint that replaces the old two-step
    nearest_ports → route_analysis workflow.

    Scans candidate ports in batches of 10 sorted by Haversine distance.
    For each candidate, calls the searoute library to generate a REAL navigable
    sea route. Ports that produce < 3 coordinates or raise any exception are
    immediately rejected — no interpolation, no straight lines.

    After each batch the port with the SHORTEST valid sea route distance is
    selected. Continues to the next batch only if no valid route was found.

    Body: { "ship_lat": float, "ship_lon": float, "ship_speed": float }

    Returns full route payload including:
      selected_port, coordinates, sea_route_distance_km, eta, fuel_tons,
      safety_score, weather_summary, candidates (top-5 for UI switcher),
      debug_log, fallback_used=false
    """
    try:
        data        = request.get_json() or {}
        ship_lat    = float(data.get('ship_lat'))
        ship_lon    = float(data.get('ship_lon'))
        speed_knots = float(data.get('ship_speed', 15.0))

        logger.info(f"▶ /api/emergency/find_route — ship=({ship_lat}, {ship_lon}), speed={speed_knots} kn")

        result = find_best_emergency_port(DB_PATH, ship_lat, ship_lon, speed_knots)

        if not result.get('success'):
            logger.error(f"❌ find_best_emergency_port failed: {result.get('error')}")
            return jsonify({'error': result.get('error', 'No valid sea route found')}), 400

        port = result['selected_port']
        logger.info(
            f"✅ Emergency route found: {port['PORT_NAME']} ({port['COUNTRY']}) — "
            f"{result['sea_route_distance_km']} km | score={result['safety_score']} | "
            f"ETA={result['eta'].get('formatted_duration')}"
        )

        # Print debug summary
        logger.info("\n--- DEBUG LOG ---")
        for line in result.get('debug_log', []):
            logger.info(f"  {line}")
        logger.info(f"  Fallback Used: FALSE")
        logger.info("--- END DEBUG LOG ---\n")

        return jsonify({
            'success':               True,
            'selected_port':         result['selected_port'],
            'sea_route_distance_km': result['sea_route_distance_km'],
            'sea_route_distance_nm': result['sea_route_distance_nm'],
            'coordinates':           result['coordinates'],
            'sampled_weather':       result['sampled_weather'],
            'weather_summary':       result['weather_summary'],
            'safety_score':          result['safety_score'],
            'safety_rating':         result['safety_rating'],
            'total_risk':            result.get('total_risk', 0),
            'risk_breakdown':        result.get('risk_breakdown', []),
            'eta':                   result['eta'],
            'fuel_tons':             result['fuel_tons'],
            'candidates':            result['candidates'],
            'debug_log':             result['debug_log'],
            'fallback_used':         False
        })

    except Exception as e:
        logger.error(f"❌ /api/emergency/find_route exception: {e}", exc_info=True)
        return jsonify({'error': str(e)}), 500


# ─── Entry Point ──────────────────────────────────────────────────────────────


if __name__ == '__main__':
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"Database '{DB_PATH}' not found.")

    # Confirm ocean_ships table exists with exactly 200 rows
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='ocean_ships'")
    if not cursor.fetchone():
        conn.close()
        raise RuntimeError("Table 'ocean_ships' not found. Run create_ocean_ships.py first.")
    cursor.execute("SELECT COUNT(*) FROM ocean_ships")
    ship_count = cursor.fetchone()[0]
    conn.close()

    init_db(DB_PATH)

    print("==================================================")
    print(" Maritime Emergency Response System")
    print(f" /ships  = ocean_ships table = {ship_count} GIS-verified vessels")
    print(" /ports  = ports table = SQLite maritime.db")
    print(" Running on http://127.0.0.1:5000")
    print("="*50)
    app.run(host='0.0.0.0', port=5000, debug=False)
