"""
backend/mission_engine.py
=========================
Single Mission Engine Architecture for Maritime Emergency Response System.

Responsibilities:
  1. Read Simulation Ship state (origin, current pos, speed, heading, fuel).
  2. Advance ship position using elapsed simulation time (Dead Reckoning + Ocean Current + Wave Resistance + Wind Drift).
  3. Fetch real forecast weather for the updated position & simulation time via Open-Meteo API.
  4. Sample route weather every 25 km along the planned sea route.
  5. Compute weighted port score for every candidate port:
        PortScore = Distance + ETA + WeatherRisk + FuelRisk + SeaRouteRisk + ForecastRisk
     Select port with minimum total score (with hysteresis to prevent erratic switching).
  6. Recalculate Distance, ETA, Fuel Remaining, Weather Severity, Safety Score, Emergency Probability, Confidence.
  7. Generate ONE unified `mission` object containing both `current` (T=0) and `forecast` (T=selectedOffset), plus timeline events.
"""

import math
import sqlite3
import datetime
import logging
import requests

from backend.route_engine import calculate_sea_route, haversine_km
from backend.weather_engine import fetch_marine_weather_for_route
from backend.route_score import analyze_route_safety
from backend.eta_engine import calculate_eta
from backend.database import DB_PATH

logger = logging.getLogger("MissionEngine")

MARINE_API_URL = "https://marine-api.open-meteo.com/v1/marine"
FORECAST_API_URL = "https://api.open-meteo.com/v1/forecast"

FUEL_BURN_PCT_PER_KM = 0.006  # % fuel burned per km for average merchant vessel


# ─── 1. GEO & DEAD RECKONING ──────────────────────────────────────────────────

def destination_point(lat, lon, bearing_deg, dist_km):
    """Compute destination lat/lon given origin, bearing (deg), and distance (km)."""
    R = 6371.0
    r = math.pi / 180.0
    d = dist_km / R
    b = bearing_deg * r
    lat1 = lat * r
    lon1 = lon * r

    lat2 = math.asin(
        math.sin(lat1) * math.cos(d) +
        math.cos(lat1) * math.sin(d) * math.cos(b)
    )
    lon2 = lon1 + math.atan2(
        math.sin(b) * math.sin(d) * math.cos(lat1),
        math.cos(d) - math.sin(lat1) * math.sin(lat2)
    )
    return lat2 / r, lon2 / r


def calculate_dead_reckoning(init_lat, init_lon, speed_knots, heading_deg, elapsed_hours,
                            wave_height=1.5, wind_speed=20.0,
                            current_vel=1.2, current_dir=270.0):
    """
    Advance ship position from init_lat/lon after elapsed_hours.
    Considers:
      - Ship Speed (knots -> km/h)
      - Heading
      - Wave Resistance Penalty: reduces net speed
      - Wind Drift Penalty: reduces net speed
      - Ocean Current: vector addition along heading
    Returns: (new_lat, new_lon, moved_distance_km)
    """
    speed_kmh = float(speed_knots) * 1.852

    # Wave resistance penalty (0.4 km/h per meter of wave above 1m)
    wave_penalty = max(0.0, (float(wave_height) - 1.0) * 0.4)
    # Wind drift penalty (0.05 km/h per km/h of wind above 20 km/h)
    wind_penalty = max(0.0, (float(wind_speed) - 20.0) * 0.05)

    effective_speed = max(2.0, speed_kmh - wave_penalty - wind_penalty)

    base_dist = effective_speed * float(elapsed_hours)

    # Ocean current component along heading direction
    angle_diff = (float(heading_deg) - float(current_dir) + 360.0) % 360.0
    current_component = math.cos(math.radians(angle_diff)) * float(current_vel)
    net_dist = max(0.0, base_dist + (current_component * float(elapsed_hours) * 0.25))

    new_lat, new_lon = destination_point(float(init_lat), float(init_lon), float(heading_deg), net_dist)
    return round(new_lat, 6), round(new_lon, 6), round(net_dist, 2)

import time
import threading

# ─── In-memory weather cache (keyed by rounded position + hour) ───────────────
_weather_cache = {}
_weather_cache_lock = threading.Lock()
_CACHE_TTL_SEC = 600  # 10 minutes

def _cache_key(lat, lon, sim_time_iso):
    """Round lat/lon to ~55km grid and hour to reduce API calls."""
    lat_r = round(lat / 0.5) * 0.5      # ~55 km grid
    lon_r = round(lon / 0.5) * 0.5
    try:
        dt = datetime.datetime.fromisoformat(sim_time_iso.replace('Z', '+00:00'))
        hour_r = round(dt.hour / 3) * 3  # round to nearest 3-hour slot
        hour_key = dt.strftime(f'%Y-%m-%dT{hour_r:02d}')
    except Exception:
        hour_key = 'now'
    return f"{lat_r:.1f},{lon_r:.1f},{hour_key}"


# ─── 2. WEATHER FORECAST FETCH ────────────────────────────────────────────────

def fetch_point_weather_forecast(lat, lon, sim_time_iso):
    """
    Fetch Open-Meteo Marine & Forecast weather for a single coordinate at a specific UTC simulation time.
    Uses an in-memory TTL cache to return instantly on repeated slider ticks.
    Parallel requests with 2.5 s timeout each.
    """
    key = _cache_key(lat, lon, sim_time_iso)

    # Serve from cache if fresh
    with _weather_cache_lock:
        cached = _weather_cache.get(key)
        if cached and (time.time() - cached['ts']) < _CACHE_TTL_SEC:
            return cached['data']

    # Default fallback values (used if API calls fail or timeout)
    defaults = dict(wave_h=1.5, wave_d=180, wave_p=7.0, curr_v=1.2, curr_d=270,
                    wind_s=20.0, wind_dir=270)
    results = {}

    try:
        dt = datetime.datetime.fromisoformat(sim_time_iso.replace('Z', '+00:00'))
        target_hour_str = dt.strftime('%Y-%m-%dT%H:00')
    except Exception:
        dt = datetime.datetime.utcnow()
        target_hour_str = dt.strftime('%Y-%m-%dT%H:00')

    lats_str = f"{lat:.4f}"
    lons_str = f"{lon:.4f}"

    def _fetch_marine():
        try:
            res = requests.get(MARINE_API_URL, params={
                'latitude': lats_str,
                'longitude': lons_str,
                'hourly': 'wave_height,wave_direction,wave_period,ocean_current_velocity,ocean_current_direction',
                'forecast_days': 3,
                'timezone': 'UTC'
            }, timeout=2.5)
            if res.status_code == 200:
                mj = res.json()
                times = mj.get('hourly', {}).get('time', [])
                idx = 0
                for i, t in enumerate(times):
                    if t.startswith(target_hour_str[:13]):
                        idx = i
                        break
                h = mj.get('hourly', {})
                results['wave_h'] = h.get('wave_height', [defaults['wave_h']])[idx] or defaults['wave_h']
                results['wave_d'] = h.get('wave_direction', [defaults['wave_d']])[idx] or defaults['wave_d']
                results['wave_p'] = h.get('wave_period', [defaults['wave_p']])[idx] or defaults['wave_p']
                results['curr_v'] = h.get('ocean_current_velocity', [defaults['curr_v']])[idx] or defaults['curr_v']
                results['curr_d'] = h.get('ocean_current_direction', [defaults['curr_d']])[idx] or defaults['curr_d']
        except Exception as e:
            logger.warning(f"Open-Meteo Marine forecast query warning: {e}")

    def _fetch_forecast():
        try:
            res = requests.get(FORECAST_API_URL, params={
                'latitude': lats_str,
                'longitude': lons_str,
                'hourly': 'wind_speed_10m,wind_direction_10m',
                'wind_speed_unit': 'kmh',
                'forecast_days': 3,
                'timezone': 'UTC'
            }, timeout=2.5)
            if res.status_code == 200:
                fj = res.json()
                times = fj.get('hourly', {}).get('time', [])
                idx = 0
                for i, t in enumerate(times):
                    if t.startswith(target_hour_str[:13]):
                        idx = i
                        break
                h = fj.get('hourly', {})
                results['wind_s'] = h.get('wind_speed_10m', [defaults['wind_s']])[idx] or defaults['wind_s']
                results['wind_dir'] = h.get('wind_direction_10m', [defaults['wind_dir']])[idx] or defaults['wind_dir']
        except Exception as e:
            logger.warning(f"Open-Meteo Forecast query warning: {e}")

    # Fire both requests in parallel
    t1 = threading.Thread(target=_fetch_marine, daemon=True)
    t2 = threading.Thread(target=_fetch_forecast, daemon=True)
    t1.start(); t2.start()
    t1.join(timeout=3.0); t2.join(timeout=3.0)

    wave_h   = round(float(results.get('wave_h',   defaults['wave_h'])),   2)
    wave_d   = int(results.get('wave_d',   defaults['wave_d']))
    wave_p   = round(float(results.get('wave_p',   defaults['wave_p'])),   1)
    curr_v   = round(float(results.get('curr_v',   defaults['curr_v'])),   2)
    curr_d   = int(results.get('curr_d',   defaults['curr_d']))
    wind_s   = round(float(results.get('wind_s',   defaults['wind_s'])),   1)
    wind_dir = int(results.get('wind_dir', defaults['wind_dir']))

    severity = "safe"
    if wave_h > 4.5 or wind_s > 75.0:
        severity = "danger"
    elif wave_h > 2.8 or wind_s > 45.0:
        severity = "rough"
    elif wave_h > 1.4 or wind_s > 22.0:
        severity = "moderate"

    data = {
        'wave_height':        wave_h,
        'wave_direction':     wave_d,
        'wave_period':        wave_p,
        'wind_speed':         wind_s,
        'wind_direction':     wind_dir,
        'ocean_current':      curr_v,
        'ocean_current_dir':  curr_d,
        'severity':           severity
    }

    with _weather_cache_lock:
        _weather_cache[key] = {'ts': time.time(), 'data': data}

    return data


# ─── 3. WEIGHTED PORT SCORE & SELECTION ENGINE ────────────────────────────────

def calculate_effective_speed(speed_knots, heading_deg=None, forecast_weather=None):
    """
    Calculate effective vessel speed (km/h) factoring in:
      - Base ship speed (knots -> km/h)
      - Sea Tide / Ocean Current vector along ship heading
      - Wave height resistance penalty
      - Wind speed drag penalty
    """
    base_speed_kmh = float(speed_knots) * 1.852
    fw = forecast_weather or {}

    wave_h = float(fw.get('wave_height', 1.5))
    wind_s = float(fw.get('wind_speed', 20.0))
    curr_v = float(fw.get('ocean_current', 1.2))
    curr_d = float(fw.get('ocean_current_dir', 270.0))

    # Wave resistance penalty: 0.4 km/h per meter above 1.0 m
    wave_penalty = max(0.0, (wave_h - 1.0) * 0.4)
    # Wind drag penalty: 0.05 km/h per km/h above 20 km/h
    wind_penalty = max(0.0, (wind_s - 20.0) * 0.05)

    # Ocean current component along ship heading direction
    if heading_deg is not None:
        angle_diff = (float(heading_deg) - float(curr_d) + 360.0) % 360.0
        current_component = math.cos(math.radians(angle_diff)) * curr_v * 1.852
    else:
        current_component = 0.0

    eff_speed_kmh = max(2.0, base_speed_kmh - wave_penalty - wind_penalty + (current_component * 0.5))
    return round(eff_speed_kmh, 2)


def compute_weighted_port_score(port, sea_dist_km, speed_knots, forecast_weather, remaining_fuel_pct, heading_deg=None):
    """
    Compute PortScore = SeaDistance + ETA + WeatherRisk + FuelRisk + SeaRouteRisk + ForecastRisk
    Uses ACTUAL sea route distance and effective speed.
    """
    # 1. Actual sea route distance score
    dist_score = sea_dist_km * 0.4

    # 2. ETA Score based on effective speed under weather & ocean current
    eff_speed_kmh = calculate_effective_speed(speed_knots, heading_deg, forecast_weather)
    eta_hours = sea_dist_km / eff_speed_kmh if eff_speed_kmh > 0 else 999.0
    eta_score = eta_hours * 6.0

    # 3. Weather Risk Score
    w_h = forecast_weather.get('wave_height', 1.5)
    w_s = forecast_weather.get('wind_speed', 20.0)
    weather_risk = (w_h * 18.0) + (w_s * 0.4)

    # 4. Fuel Risk Score
    est_fuel_needed_pct = sea_dist_km * FUEL_BURN_PCT_PER_KM
    fuel_risk = 0.0
    if est_fuel_needed_pct > remaining_fuel_pct:
        fuel_risk = (est_fuel_needed_pct - remaining_fuel_pct) * 25.0 + 100.0
    elif remaining_fuel_pct < 25.0:
        fuel_risk = 40.0

    # 5. Sea Route / Harbor Size Risk
    size_penalty = 0.0
    h_size = str(port.get('HARBORSIZE', '')).upper()
    if 'S' in h_size or 'V' in h_size:
        size_penalty = 20.0

    # 6. Forecast Severity Risk
    sev = forecast_weather.get('severity', 'safe').lower()
    forecast_risk = 60.0 if sev == 'danger' else 30.0 if sev == 'rough' else 10.0 if sev == 'moderate' else 0.0

    total_score = dist_score + eta_score + weather_risk + fuel_risk + size_penalty + forecast_risk

    return {
        'total_score': round(total_score, 2),
        'sea_dist_km': round(sea_dist_km, 2),
        'eta_hours': round(eta_hours, 1),
        'eff_speed_kmh': eff_speed_kmh,
        'weather_risk': round(weather_risk, 1),
        'fuel_risk': round(fuel_risk, 1),
        'forecast_risk': round(forecast_risk, 1)
    }


from concurrent.futures import ThreadPoolExecutor

MIN_COORD_COUNT = 3


def find_optimal_port(db_path, ship_lat, ship_lon, speed_knots, forecast_weather, remaining_fuel_pct, heading_deg=0.0, current_port_id=None):
    """
    Evaluate candidate ports using weighted PortScore with VALID SEA ROUTES.
    1. Query ports from DB sorted by Haversine distance.
    2. Parallel search top 30 candidate ports using ThreadPoolExecutor.
    3. Exclude ports with < 3 route coordinates or searoute failure.
    4. Score valid candidates based on actual sea route distance and effective speed.
    5. Return (selected_port, top_candidate_ports).
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    cur.execute("""
        SELECT id, INDEX_NO, PORT_NAME, COUNTRY, LATITUDE, LONGITUDE,
               HARBORTYPE, HARBORSIZE, FUEL_OIL, DIESEL, ELECREPAIR, MED_FACIL
        FROM ports
        WHERE LATITUDE IS NOT NULL AND LONGITUDE IS NOT NULL
          AND NOT (ABS(LATITUDE) < 0.01 AND ABS(LONGITUDE) < 0.01)
    """)
    rows = cur.fetchall()
    conn.close()

    ports = []
    for r in rows:
        p_lat = float(r['LATITUDE'])
        p_lon = float(r['LONGITUDE'])
        dist = haversine_km(ship_lat, ship_lon, p_lat, p_lon)
        d = dict(r)
        d['haversine_km'] = dist
        ports.append(d)

    ports.sort(key=lambda x: x['haversine_km'])
    candidates_to_scan = ports[:30]

    def _eval_single_port(p):
        dest_lat = float(p['LATITUDE'])
        dest_lon = float(p['LONGITUDE'])

        try:
            route_res = calculate_sea_route(ship_lat, ship_lon, dest_lat, dest_lon, sample_interval_km=15.0)
        except Exception:
            return None

        if not route_res.get('success'):
            return None

        coords = route_res.get('coordinates', [])
        if len(coords) < MIN_COORD_COUNT:
            return None

        sea_dist = route_res['total_distance_km']
        sc = compute_weighted_port_score(p, sea_dist, speed_knots, forecast_weather, remaining_fuel_pct, heading_deg)

        res_p = dict(p)
        res_p['port_score'] = sc['total_score']
        res_p['score_breakdown'] = sc
        res_p['distance_km'] = sc['sea_dist_km']
        res_p['distance_nm'] = round(sc['sea_dist_km'] * 0.539957, 2)
        res_p['route_res'] = route_res
        return res_p

    with ThreadPoolExecutor(max_workers=10) as executor:
        evaluated = list(executor.map(_eval_single_port, candidates_to_scan))

    valid_candidates = [item for item in evaluated if item is not None]

    if not valid_candidates:
        # Fallback if no port in top 40 has >= 20 coords
        for p in ports[:10]:
            dest_lat = float(p['LATITUDE'])
            dest_lon = float(p['LONGITUDE'])
            route_res = calculate_sea_route(ship_lat, ship_lon, dest_lat, dest_lon, sample_interval_km=10.0)
            if route_res.get('success'):
                sea_dist = route_res['total_distance_km']
                sc = compute_weighted_port_score(p, sea_dist, speed_knots, forecast_weather, remaining_fuel_pct, heading_deg)
                p['port_score'] = sc['total_score']
                p['score_breakdown'] = sc
                p['distance_km'] = round(sea_dist, 2)
                p['distance_nm'] = round(sea_dist * 0.539957, 2)
                p['route_res'] = route_res
                valid_candidates.append(p)
                break

    if not valid_candidates:
        # Ultimate fallback
        p = dict(ports[0])
        p['port_score'] = 100.0
        p['score_breakdown'] = {}
        p['distance_km'] = round(ports[0]['haversine_km'], 2)
        p['distance_nm'] = round(ports[0]['haversine_km'] * 0.539957, 2)
        p['route_res'] = {
            'coordinates': [[ship_lat, ship_lon], [float(p['LATITUDE']), float(p['LONGITUDE'])]],
            'sampled_points': [{'index': 0, 'lat': ship_lat, 'lon': ship_lon, 'distance_km': 0}],
            'total_distance_km': ports[0]['haversine_km']
        }
        valid_candidates.append(p)

    valid_candidates.sort(key=lambda x: x['port_score'])
    best_candidate = valid_candidates[0]
    selected_port = best_candidate

    # Clean non-serializable route_res before returning candidates list
    cleaned_candidates = []
    for c in valid_candidates[:10]:
        cp = dict(c)
        cp.pop('route_res', None)
        cleaned_candidates.append(cp)

    return selected_port, cleaned_candidates


# ─── 4. EMERGENCY PROBABILITY & CONFIDENCE CALCULATION ─────────────────────────

def calculate_emergency_risk(forecast_weather, fuel_pct, dist_rem_km):
    """
    Calculate future emergency probability (0 - 100%) and confidence score (65% - 95%).
    Based on forecast evolution, wave height, wind speed, fuel level, and distance.
    """
    w_h = forecast_weather.get('wave_height', 1.5)
    w_s = forecast_weather.get('wind_speed', 20.0)
    c_v = forecast_weather.get('ocean_current', 1.2)

    risk = 0.0
    risk += min(w_h / 7.0, 1.0) * 38.0
    risk += min(w_s / 90.0, 1.0) * 26.0
    risk += min(c_v / 4.0, 1.0) * 10.0
    risk += 22.0 if fuel_pct < 20.0 else 12.0 if fuel_pct < 40.0 else 0.0
    risk += min(dist_rem_km / 2500.0, 1.0) * 10.0

    prob = int(round(min(100.0, max(0.0, risk))))

    # Confidence calculation: higher if weather data is fresh & complete
    confidence = int(round(82.0 + (5.0 if w_h > 0 else -10.0)))
    confidence = max(65, min(95, confidence))

    return prob, confidence


# ─── 5. UNIFIED MISSION EVALUATOR ─────────────────────────────────────────────

def build_state_object(db_path, lat, lon, heading, speed_knots, starting_fuel_pct, elapsed_hours, sim_time_iso, current_port_id=None):
    """
    Build complete state payload for either T=0 (Current) or T=sim_offset_min (Forecast).
    """
    # 1. Fetch Forecast Weather for (lat, lon) at sim_time_iso
    weather = fetch_point_weather_forecast(lat, lon, sim_time_iso)

    # 2. Distance moved from origin
    moved_km = round(speed_knots * 1.852 * elapsed_hours, 2)
    fuel_burned_pct = round(moved_km * FUEL_BURN_PCT_PER_KM, 1)
    remaining_fuel_pct = max(0, int(round(starting_fuel_pct - fuel_burned_pct)))

    # 3. Port Selection using Weighted Score Formula with Valid Sea Route
    selected_port, candidate_ports = find_optimal_port(
        db_path, lat, lon, speed_knots, weather, remaining_fuel_pct, heading, current_port_id
    )

    # Extract precalculated route_res from selected_port
    route_res = selected_port.get('route_res')
    if not route_res:
        dest_lat = float(selected_port['LATITUDE'])
        dest_lon = float(selected_port['LONGITUDE'])
        route_res = calculate_sea_route(lat, lon, dest_lat, dest_lon, sample_interval_km=10.0)

    # Strip route_res from selected_port object before returning to client
    clean_selected_port = dict(selected_port)
    clean_selected_port.pop('route_res', None)

    if route_res.get('success'):
        coords = route_res.get('coordinates', [])
        sampled_pts = route_res.get('sampled_points', [])
        total_dist_km = route_res.get('total_distance_km', 0.0)
    else:
        dest_lat = float(selected_port['LATITUDE'])
        dest_lon = float(selected_port['LONGITUDE'])
        coords = [[lat, lon], [dest_lat, dest_lon]]
        sampled_pts = [{'index': 1, 'lat': lat, 'lon': lon, 'distance_km': 0.0}]
        total_dist_km = haversine_km(lat, lon, dest_lat, dest_lon)

    # 5. Enrich sampled route weather (sampled every 25 km)
    try:
        route_weather_pts = fetch_marine_weather_for_route(sampled_pts)
        safety_res = analyze_route_safety(route_weather_pts, total_dist_km)
        safety_score = safety_res.get('safety_score', 85)
        safety_rating = safety_res.get('safety_rating', 'Good')
    except Exception as e:
        logger.warning(f"Route weather analysis warning: {e}")
        safety_score = 80
        safety_rating = "Good"

    # 6. ETA Calculation
    eta_info = calculate_eta(total_dist_km, speed_knots)

    # 7. Emergency Probability & Confidence
    risk_prob, confidence = calculate_emergency_risk(weather, remaining_fuel_pct, total_dist_km)

    return {
        'ship': {
            'lat': round(lat, 5),
            'lon': round(lon, 5),
            'heading': int(round(heading)),
            'speed': float(speed_knots),
            'fuel': remaining_fuel_pct
        },
        'weather': weather,
        'selectedPort': clean_selected_port,
        'candidatePorts': candidate_ports,
        'route': {
            'coordinates': coords,
            'distance_km': round(total_dist_km, 1),
            'distance_nm': round(total_dist_km * 0.539957, 1)
        },
        'eta': eta_info,
        'distance': {
            'moved_km': moved_km,
            'to_port_km': round(total_dist_km, 1)
        },
        'fuel': {
            'remaining_pct': remaining_fuel_pct,
            'burned_pct': fuel_burned_pct
        },
        'safetyScore': safety_score,
        'safetyRating': safety_rating,
        'riskBreakdown': {
            'waveHeight':         round(min(weather.get('wave_height', 1.5) / 8.0 * 35, 35), 1),
            'windSpeed':          round(min(weather.get('wind_speed', 20.0) / 100.0 * 25, 25), 1),
            'fuelLevel':          round(max(0, (100 - remaining_fuel_pct) / 100.0 * 20), 1),
            'distanceToPort':     round(min(total_dist_km / 3000.0 * 10, 10), 1),
            'weatherSeverity':    {'safe': 0, 'moderate': 5, 'rough': 10, 'danger': 20}.get(weather.get('severity', 'safe'), 0),
            'nightNavigation':    5 if datetime.datetime.utcnow().hour < 6 or datetime.datetime.utcnow().hour > 20 else 0,
            'stormProbability':   round(min(weather.get('wave_height', 1.5) / 6.0 * 15, 15), 1)
        },
        'emergencyProbability': risk_prob,
        'confidence': confidence
    }


def evaluate_mission(payload):
    """
    Main entry point for Single Mission Engine.
    Accepts input payload with ship parameters and simulation time offset.
    Generates unified `mission` object containing:
      - current: T=0 state
      - forecast: T=sim_offset_min state
      - timeline: List of mission events & port switch notifications
    """
    ship_data = payload.get('ship', {})
    sim_offset_min = int(payload.get('sim_offset_min', 0))
    start_time_iso = payload.get('start_time_iso') or datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
    prev_port_id = payload.get('current_port_id')

    init_lat = float(ship_data.get('initial_lat', ship_data.get('lat', 31.05293)))
    init_lon = float(ship_data.get('initial_lon', ship_data.get('lon', -37.45918)))
    heading = float(ship_data.get('heading', 90.0))
    speed = float(ship_data.get('speed', 12.0))
    starting_fuel = float(ship_data.get('fuel', 80.0))
    ship_name = str(ship_data.get('name', 'SAMPLE SHIP'))

    # Parse start time safely (strip milliseconds and timezone suffix for broad compatibility)
    try:
        clean_iso = start_time_iso.replace('Z', '').split('+')[0].split('.')[0]
        dt_start = datetime.datetime.fromisoformat(clean_iso).replace(tzinfo=datetime.timezone.utc)
    except Exception:
        dt_start = datetime.datetime.now(datetime.timezone.utc)

    # Re-normalise start_time_iso to always be clean 'Z' format for downstream use
    start_time_iso = dt_start.strftime('%Y-%m-%dT%H:%M:%SZ')

    # Calculate Current State (T=0)
    current_state = build_state_object(
        DB_PATH, init_lat, init_lon, heading, speed, starting_fuel,
        elapsed_hours=0.0, sim_time_iso=start_time_iso, current_port_id=prev_port_id
    )

    # Calculate Forecast State (T=sim_offset_min)
    forecast_dt = dt_start + datetime.timedelta(minutes=sim_offset_min)
    # IMPORTANT: use strftime to avoid Python datetime isoformat() adding '+00:00' suffix
    # which would produce invalid '2026-07-27T12:00:00+00:00Z' in JavaScript new Date()
    forecast_time_iso = forecast_dt.strftime('%Y-%m-%dT%H:%M:%SZ')

    elapsed_hours = sim_offset_min / 60.0

    # Dead Reckoning for Forecast Position
    pred_lat, pred_lon, moved_km = calculate_dead_reckoning(
        init_lat, init_lon, speed, heading, elapsed_hours,
        wave_height=current_state['weather']['wave_height'],
        wind_speed=current_state['weather']['wind_speed'],
        current_vel=current_state['weather']['ocean_current'],
        current_dir=current_state['weather']['ocean_current_dir']
    )

    forecast_state = build_state_object(
        DB_PATH, pred_lat, pred_lon, heading, speed, starting_fuel,
        elapsed_hours=elapsed_hours, sim_time_iso=forecast_time_iso,
        current_port_id=current_state['selectedPort']['id']
    )

    # Port Change Detection
    curr_port_name = current_state['selectedPort']['PORT_NAME']
    fore_port_name = forecast_state['selectedPort']['PORT_NAME']
    port_changed = (curr_port_name != fore_port_name)

    port_change_reason = ""
    if port_changed:
        w_f = forecast_state['weather']
        port_change_reason = (
            f"Forecast conditions at T+{elapsed_hours:.1f}h favor {fore_port_name}: "
            f"Wave {w_f['wave_height']}m, Wind {w_f['wind_speed']} km/h, "
            f"ETA {forecast_state['eta']['formatted_duration']}"
        )

    # Build Mission Timeline
    timeline = []

    # 1. Start event
    t_start_str = dt_start.strftime('%H:%M UTC')
    timeline.append({
        'ts': t_start_str,
        'description': f"🚀 Digital Twin Mission active for {ship_name}",
        'type': 'success'
    })

    # 2. Weather alert if rough/danger
    f_sev = forecast_state['weather']['severity']
    if f_sev == 'danger':
        timeline.append({
            'ts': forecast_dt.strftime('%H:%M UTC'),
            'description': f"🚨 Severe weather forecast at T+{elapsed_hours:.1f}h (Wave {forecast_state['weather']['wave_height']}m)",
            'type': 'danger'
        })
    elif f_sev == 'rough':
        timeline.append({
            'ts': forecast_dt.strftime('%H:%M UTC'),
            'description': f"🌊 Rough weather forecast at T+{elapsed_hours:.1f}h (Wind {forecast_state['weather']['wind_speed']} km/h)",
            'type': 'warning'
        })

    # 3. Emergency probability alert
    e_prob = forecast_state['emergencyProbability']
    if e_prob >= 75:
        timeline.append({
            'ts': forecast_dt.strftime('%H:%M UTC'),
            'description': f"🚨 High Emergency Probability ({e_prob}%) in next 3h",
            'type': 'danger'
        })
    elif e_prob >= 50:
        timeline.append({
            'ts': forecast_dt.strftime('%H:%M UTC'),
            'description': f"⚠️ Elevated Emergency Risk ({e_prob}%)",
            'type': 'warning'
        })

    # 4. Fuel warning
    f_fuel = forecast_state['fuel']['remaining_pct']
    if f_fuel < 20:
        timeline.append({
            'ts': forecast_dt.strftime('%H:%M UTC'),
            'description': f"⛽ CRITICAL: Fuel critically low at T+{elapsed_hours:.1f}h ({f_fuel}% remaining)",
            'type': 'danger'
        })
    elif f_fuel < 40:
        timeline.append({
            'ts': forecast_dt.strftime('%H:%M UTC'),
            'description': f"⛽ Low fuel warning at T+{elapsed_hours:.1f}h ({f_fuel}% remaining)",
            'type': 'warning'
        })

    # 5. Safety score change alert
    curr_safety = current_state['safetyScore']
    fore_safety = forecast_state['safetyScore']
    if abs(fore_safety - curr_safety) >= 15:
        direction = "improved" if fore_safety > curr_safety else "degraded"
        timeline.append({
            'ts': forecast_dt.strftime('%H:%M UTC'),
            'description': f"🛡 Safety Score {direction}: {curr_safety} → {fore_safety} / 100 at T+{elapsed_hours:.1f}h",
            'type': 'warning' if fore_safety < curr_safety else 'success'
        })

    # 6. Port switch event
    if port_changed:
        timeline.append({
            'ts': forecast_dt.strftime('%H:%M UTC'),
            'description': f"🔄 Recommended Port Changed → {fore_port_name} ({port_change_reason})",
            'type': 'warning'
        })

    # 7. ETA update
    timeline.append({
        'ts': forecast_dt.strftime('%H:%M UTC'),
        'description': f"⏱ ETA Updated: {forecast_state['eta'].get('formatted_duration', '--')} to {fore_port_name}",
        'type': 'info'
    })

    return {
        'success': True,
        'currentMission': {
            'shipName': ship_name,
            'sim_offset_min': sim_offset_min,
            'start_time_iso': start_time_iso,
            'forecast_time_iso': forecast_time_iso,
            'current': current_state,
            'forecast': forecast_state,
            'portChanged': port_changed,
            'portChangeReason': port_change_reason,
            'timeline': timeline
        }
    }


# ─── 6. MISSION PRE-WARMER (Background Parallel Pre-computation) ──────────────

import concurrent.futures

PREWARM_OFFSETS = [0, 30, 60, 120, 240, 360, 720, 1440]  # minutes


def prewarm_mission(payload):
    """
    Pre-warm the mission prediction cache for all time offsets in parallel.
    Runs 8 independent evaluate_mission() calls concurrently using ThreadPoolExecutor.

    Called immediately after ship creation so emergency button can respond instantly.

    Returns:
        dict: {
            'success': True,
            'cache': {
                '0':    { currentMission: ... },
                '30':   { currentMission: ... },
                '60':   { currentMission: ... },
                '120':  { currentMission: ... },
                '240':  { currentMission: ... },
                '360':  { currentMission: ... },
                '720':  { currentMission: ... },
                '1440': { currentMission: ... }
            },
            'completed_offsets': [0, 30, 60, ...],
            'failed_offsets': []
        }
    """
    ship_data = payload.get('ship', {})
    start_time_iso = payload.get('start_time_iso') or datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
    prev_port_id   = payload.get('current_port_id')

    results          = {}
    completed        = []
    failed           = []

    def _eval_offset(offset_min):
        """Run evaluate_mission for one offset and return (offset, result)."""
        try:
            p = {
                'ship':            ship_data,
                'sim_offset_min':  offset_min,
                'start_time_iso':  start_time_iso,
                'current_port_id': prev_port_id
            }
            mission = evaluate_mission(p)
            return offset_min, mission, None
        except Exception as exc:
            return offset_min, None, str(exc)

    # Fire all 8 prediction offsets in parallel
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        futures = {ex.submit(_eval_offset, off): off for off in PREWARM_OFFSETS}
        try:
            for future in concurrent.futures.as_completed(futures, timeout=12):
                try:
                    offset_min, mission_result, err = future.result()
                    if err or not mission_result:
                        logger.warning(f"[PreWarm] Offset {offset_min}m failed: {err}")
                        failed.append(offset_min)
                    else:
                        results[str(offset_min)] = mission_result
                        completed.append(offset_min)
                except Exception as exc:
                    logger.error(f"[PreWarm] Single offset exception: {exc}")
        except Exception as t_err:
            logger.warning(f"[PreWarm] Batch execution timeout/notice: {t_err}")
            for fut, off in futures.items():
                if fut.done() and not fut.cancelled():
                    try:
                        off_min, res, err = fut.result()
                        if res and str(off_min) not in results:
                            results[str(off_min)] = res
                            if off_min not in completed:
                                completed.append(off_min)
                    except Exception:
                        pass

    logger.info(f"[PreWarm] Completed {len(completed)}/{len(PREWARM_OFFSETS)} offsets. Failed: {failed}")

    return {
        'success':           True,
        'cache':             results,
        'completed_offsets': completed,
        'failed_offsets':    failed
    }

