"""
backend/weather_engine.py
========================
High-Performance Open-Meteo Marine & Forecast API Integrator.
Fetches real marine weather along sampled route points with in-memory caching and fast timeouts.
"""

import logging
import time
import requests

logger = logging.getLogger("WeatherEngine")

MARINE_API_URL = "https://marine-api.open-meteo.com/v1/marine"
FORECAST_API_URL = "https://api.open-meteo.com/v1/forecast"

# 15-minute in-memory cache for weather points
_WEATHER_CACHE = {}
_CACHE_TTL = 900  # 15 minutes in seconds

def _get_cache_key(lat, lon):
    return f"{round(float(lat), 1)},{round(float(lon), 1)}"

def fetch_point_weather_forecast(lat, lon, sim_time_iso="now"):
    """
    Fetch weather forecast for a single point with fast cache & 0.8s timeout.
    """
    ckey = _get_cache_key(lat, lon)
    now_ts = time.time()
    if ckey in _WEATHER_CACHE:
        cached_val, timestamp = _WEATHER_CACHE[ckey]
        if now_ts - timestamp < _CACHE_TTL:
            return cached_val

    # Default fallback weather
    fallback = {
        'wave_height': 1.5,
        'wave_direction': 180,
        'wave_period': 5.0,
        'wind_speed': 18.0,
        'wind_direction': 180,
        'ocean_current': 1.1,
        'ocean_current_dir': 270,
        'severity': 'safe'
    }

    try:
        m_params = {
            'latitude': str(lat),
            'longitude': str(lon),
            'current': 'wave_height,wave_direction,wave_period,ocean_current_velocity,ocean_current_direction'
        }
        res_m = requests.get(MARINE_API_URL, params=m_params, timeout=0.8)
        if res_m.status_code == 200:
            m_data = res_m.json().get('current', {})
            fallback['wave_height'] = round(float(m_data.get('wave_height', 1.5) or 1.5), 2)
            fallback['wave_direction'] = int(m_data.get('wave_direction', 180) or 180)
            fallback['wave_period'] = round(float(m_data.get('wave_period', 5.0) or 5.0), 1)
            fallback['ocean_current'] = round(float(m_data.get('ocean_current_velocity', 1.1) or 1.1), 2)
            fallback['ocean_current_dir'] = int(m_data.get('ocean_current_direction', 270) or 270)
    except Exception:
        pass

    try:
        f_params = {
            'latitude': str(lat),
            'longitude': str(lon),
            'current': 'wind_speed_10m,wind_direction_10m'
        }
        res_f = requests.get(FORECAST_API_URL, params=f_params, timeout=0.8)
        if res_f.status_code == 200:
            f_data = res_f.json().get('current', {})
            fallback['wind_speed'] = round(float(f_data.get('wind_speed_10m', 18.0) or 18.0), 1)
            fallback['wind_direction'] = int(f_data.get('wind_direction_10m', 180) or 180)
    except Exception:
        pass

    # Severity classification
    w_h = fallback['wave_height']
    w_s = fallback['wind_speed']
    if w_h >= 4.0 or w_s >= 60.0:
        fallback['severity'] = 'danger'
    elif w_h >= 2.5 or w_s >= 40.0:
        fallback['severity'] = 'rough'
    elif w_h >= 1.5 or w_s >= 25.0:
        fallback['severity'] = 'moderate'
    else:
        fallback['severity'] = 'safe'

    _WEATHER_CACHE[ckey] = (fallback, now_ts)
    return fallback


def fetch_marine_weather_for_route(sampled_points, batch_size=30):
    """
    Fetch marine weather for sampled route points with fast batching & 0.8s max timeout.
    """
    if not sampled_points:
        return []

    enriched_points = []
    now_ts = time.time()

    for i in range(0, len(sampled_points), batch_size):
        batch = sampled_points[i:i + batch_size]
        uncached = []
        for p in batch:
            ckey = _get_cache_key(p['lat'], p['lon'])
            if ckey in _WEATHER_CACHE and (now_ts - _WEATHER_CACHE[ckey][1] < _CACHE_TTL):
                c_data = _WEATHER_CACHE[ckey][0]
                enriched_points.append({
                    'index': p['index'],
                    'lat': p['lat'],
                    'lon': p['lon'],
                    'distance_km': p['distance_km'],
                    'wave_height': c_data['wave_height'],
                    'wave_direction': c_data['wave_direction'],
                    'wave_period': c_data['wave_period'],
                    'wind_speed': c_data['wind_speed'],
                    'wind_direction': c_data['wind_direction'],
                    'ocean_current_velocity': c_data['ocean_current'],
                    'ocean_current_direction': c_data['ocean_current_dir']
                })
            else:
                uncached.append(p)

        if not uncached:
            continue

        lats_str = ",".join([str(p['lat']) for p in uncached])
        lons_str = ",".join([str(p['lon']) for p in uncached])

        marine_data = []
        forecast_data = []

        try:
            m_params = {
                'latitude': lats_str,
                'longitude': lons_str,
                'current': 'wave_height,wave_direction,wave_period,ocean_current_velocity,ocean_current_direction'
            }
            res_m = requests.get(MARINE_API_URL, params=m_params, timeout=0.8)
            if res_m.status_code == 200:
                res_json = res_m.json()
                marine_data = res_json if isinstance(res_json, list) else [res_json]
        except Exception:
            pass

        try:
            f_params = {
                'latitude': lats_str,
                'longitude': lons_str,
                'current': 'wind_speed_10m,wind_direction_10m'
            }
            res_f = requests.get(FORECAST_API_URL, params=f_params, timeout=0.8)
            if res_f.status_code == 200:
                res_json = res_f.json()
                forecast_data = res_json if isinstance(res_json, list) else [res_json]
        except Exception:
            pass

        for idx, point in enumerate(uncached):
            m_curr = marine_data[idx].get('current', {}) if idx < len(marine_data) and isinstance(marine_data[idx], dict) else {}
            f_curr = forecast_data[idx].get('current', {}) if idx < len(forecast_data) and isinstance(forecast_data[idx], dict) else {}

            wave_height = round(float(m_curr.get('wave_height', 1.5) or 1.5), 2)
            wave_direction = int(m_curr.get('wave_direction', 180) or 180)
            wave_period = round(float(m_curr.get('wave_period', 5.0) or 5.0), 1)
            wind_speed = round(float(f_curr.get('wind_speed_10m', 18.0) or 18.0), 1)
            wind_direction = int(f_curr.get('wind_direction_10m', 180) or 180)
            current_vel = round(float(m_curr.get('ocean_current_velocity', 1.1) or 1.1), 2)
            current_dir = int(m_curr.get('ocean_current_direction', 270) or 270)

            item = {
                'index': point['index'],
                'lat': point['lat'],
                'lon': point['lon'],
                'distance_km': point['distance_km'],
                'wave_height': wave_height,
                'wave_direction': wave_direction,
                'wave_period': wave_period,
                'wind_speed': wind_speed,
                'wind_direction': wind_direction,
                'ocean_current_velocity': current_vel,
                'ocean_current_direction': current_dir
            }
            enriched_points.append(item)

            ckey = _get_cache_key(point['lat'], point['lon'])
            _WEATHER_CACHE[ckey] = ({
                'wave_height': wave_height, 'wave_direction': wave_direction,
                'wave_period': wave_period, 'wind_speed': wind_speed,
                'wind_direction': wind_direction, 'ocean_current': current_vel,
                'ocean_current_dir': current_dir, 'severity': 'safe'
            }, now_ts)

    enriched_points.sort(key=lambda x: x['index'])
    return enriched_points
