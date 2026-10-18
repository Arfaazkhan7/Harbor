"""
backend/eta_engine.py
=====================
Estimated Time of Arrival (ETA) Calculation Engine.
Calculates ETA based on total sea route distance and vessel speed.
"""

from datetime import datetime, timedelta, timezone
import logging

logger = logging.getLogger("ETAEngine")

KNOTS_TO_KMH = 1.852


def calculate_eta(distance_km, speed_knots):
    """
    Calculate Estimated Time of Arrival (ETA) given route distance and vessel speed.

    Args:
        distance_km (float): Total route distance in kilometers.
        speed_knots (float): Ship speed in knots (nautical miles per hour).

    Returns:
        dict: {
            'distance_km': float,
            'distance_nm': float,
            'speed_knots': float,
            'speed_kmh': float,
            'travel_hours_total': float,
            'duration_hours': int,
            'duration_minutes': int,
            'formatted_duration': str, # e.g. "12h 34m"
            'arrival_utc': str, # e.g. "2026-07-27 05:00 UTC"
            'arrival_iso': str
        }
    """
    safe_speed_knots = float(speed_knots) if speed_knots and float(speed_knots) > 0 else 15.0
    safe_distance_km = float(distance_km) if distance_km and float(distance_km) >= 0 else 0.0

    speed_kmh = safe_speed_knots * KNOTS_TO_KMH
    travel_hours = safe_distance_km / speed_kmh

    hours = int(travel_hours)
    minutes = int(round((travel_hours - hours) * 60))

    if minutes >= 60:
        hours += 1
        minutes = 0

    now_utc = datetime.now(timezone.utc)
    arrival_time = now_utc + timedelta(hours=travel_hours)

    distance_nm = safe_distance_km * 0.539957

    formatted_duration = f"{hours}h {minutes}m" if hours > 0 else f"{minutes}m"

    return {
        'distance_km': round(safe_distance_km, 2),
        'distance_nm': round(distance_nm, 2),
        'speed_knots': round(safe_speed_knots, 1),
        'speed_kmh': round(speed_kmh, 1),
        'travel_hours_total': round(travel_hours, 2),
        'duration_hours': hours,
        'duration_minutes': minutes,
        'formatted_duration': formatted_duration,
        'arrival_utc': arrival_time.strftime("%Y-%m-%d %H:%M UTC"),
        'arrival_iso': arrival_time.isoformat()
    }
