"""
backend/emergency_router.py
============================
Emergency Sea Route Router — finds the port with the SHORTEST VALID sea route.

Algorithm:
  1. Load nearest N ports from DB sorted by Haversine distance (batch_size=10).
  2. For each candidate port, attempt searoute generation.
     - If result has < 3 coords OR exception → REJECT, print reason, try next.
     - If valid → compute distance, ETA, fuel, safety score, store as candidate.
  3. After testing all batch candidates → select port with SHORTEST valid sea route.
     NOT the geographically nearest.
  4. If no batch candidate succeeds → load next batch and repeat.
  5. Exhaustion → raise ValueError("No valid sea route found").

Straight-line fallback: NEVER used. Only real searoute results are accepted.
"""

import math
import sqlite3
import logging

from backend.route_engine    import calculate_sea_route, haversine_km
from backend.weather_engine  import fetch_marine_weather_for_route
from backend.route_score     import analyze_route_safety
from backend.eta_engine      import calculate_eta

logger = logging.getLogger("EmergencyRouter")

BATCH_SIZE      = 10      # Ports tested per iteration
FUEL_PER_KM     = 0.08   # Tons of fuel per km (rough estimate)
MIN_COORD_COUNT = 20     # Minimum searoute coordinates to accept a route (dense geometry only)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _bearing(ship_lat, ship_lon, p_lat, p_lon):
    """Compass bearing from ship to port (0-360°)."""
    lat1 = math.radians(ship_lat)
    lat2 = math.radians(p_lat)
    dlon = math.radians(p_lon - ship_lon)
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def _all_ports_sorted(db_path, ship_lat, ship_lon):
    """
    Load every port from the DB, compute Haversine distance from ship,
    return list sorted by ascending distance.
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur  = conn.cursor()
    cur.execute("""
        SELECT id, INDEX_NO, PORT_NAME, COUNTRY, LATITUDE, LONGITUDE,
               HARBORTYPE, HARBORSIZE, FUEL_OIL, DIESEL, ELECREPAIR, MED_FACIL
        FROM ports
        WHERE LATITUDE  IS NOT NULL
          AND LONGITUDE IS NOT NULL
          AND NOT (ABS(LATITUDE) < 0.01 AND ABS(LONGITUDE) < 0.01)
    """)
    rows = cur.fetchall()
    conn.close()

    ports = []
    for r in rows:
        p_lat = float(r['LATITUDE'])
        p_lon = float(r['LONGITUDE'])
        dist  = haversine_km(ship_lat, ship_lon, p_lat, p_lon)
        bear  = _bearing(ship_lat, ship_lon, p_lat, p_lon)
        d = dict(r)
        d['distance_km'] = round(dist, 2)
        d['distance_nm'] = round(dist * 0.539957, 2)
        d['bearing_deg'] = round(bear, 1)
        ports.append(d)

    ports.sort(key=lambda x: x['distance_km'])
    return ports


# ─── Main Entry Point ─────────────────────────────────────────────────────────

# ─── Main Entry Point ─────────────────────────────────────────────────────────

from backend.mission_engine import find_optimal_port, fetch_point_weather_forecast, calculate_effective_speed

def find_best_emergency_port(db_path, ship_lat, ship_lon, speed_knots=15.0, heading_deg=0.0):
    """
    Find best emergency port using unified sea-route port score engine.
    Guarantees 100% agreement with MissionEngine.
    """
    ship_lat = float(ship_lat)
    ship_lon = float(ship_lon)
    speed_knots = float(speed_knots)

    logger.info(f"[EmergencyRouter] Initiated for ship at [{ship_lat:.5f}, {ship_lon:.5f}], speed={speed_knots}kn")

    weather = fetch_point_weather_forecast(ship_lat, ship_lon, "now")

    selected, candidates = find_optimal_port(
        db_path, ship_lat, ship_lon, speed_knots, weather, remaining_fuel_pct=80.0, heading_deg=heading_deg
    )

    dest_lat = float(selected['LATITUDE'])
    dest_lon = float(selected['LONGITUDE'])

    route_res = calculate_sea_route(ship_lat, ship_lon, dest_lat, dest_lon, sample_interval_km=10.0)

    if not route_res.get('success'):
        return {'success': False, 'error': route_res.get('error', 'Route generation failed')}

    coords = route_res['coordinates']
    sea_dist_km = route_res['total_distance_km']
    sea_dist_nm = route_res['total_distance_nm']
    sampled_pts = route_res.get('sampled_points', [])

    try:
        weather_pts = fetch_marine_weather_for_route(sampled_pts)
    except Exception as w_err:
        logger.warning(f"Weather fetch exception: {w_err}")
        weather_pts = sampled_pts

    safety = analyze_route_safety(weather_pts, total_distance_km=sea_dist_km)

    eff_speed = calculate_effective_speed(speed_knots, heading_deg, weather)
    eta_hours = sea_dist_km / eff_speed if eff_speed > 0 else 999.0
    eta_info = calculate_eta(sea_dist_km, speed_knots)
    eta_info['formatted_duration'] = f"{int(eta_hours)}h {int((eta_hours % 1) * 60)}m"

    fuel_tons = round(sea_dist_km * FUEL_PER_KM, 1)

    return {
        'success':               True,
        'selected_port':         selected,
        'sea_route_distance_km': round(sea_dist_km, 2),
        'sea_route_distance_nm': round(sea_dist_nm, 2),
        'coordinates':           coords,
        'sampled_weather':       safety['analyzed_points'],
        'weather_summary':       safety['summary'],
        'safety_score':          safety['safety_score'],
        'safety_rating':         safety['safety_rating'],
        'total_risk':            safety.get('total_risk', 0),
        'risk_breakdown':        safety.get('risk_breakdown', []),
        'eta':                   eta_info,
        'fuel_tons':             fuel_tons,
        'candidates':            candidates,
        'debug_log':             [f"Selected {selected['PORT_NAME']} ({sea_dist_km} km) via unified MissionEngine"],
        'fallback_used':         False
    }
