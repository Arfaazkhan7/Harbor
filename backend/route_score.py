"""
backend/route_score.py
======================
Route Safety Analysis and Safety Score Engine.
Analyzes weather points along sea route and computes overall safety score.
"""

import logging

logger = logging.getLogger("RouteScore")


def classify_wave(wave_height):
    """
    Classify Wave Height:
      0-1 m   -> Safe
      1-2 m   -> Moderate
      2-3 m   -> Rough
      Above 3m -> Danger
    """
    if wave_height <= 1.0:
        return "Safe", 0
    elif wave_height <= 2.0:
        return "Moderate", 1
    elif wave_height <= 3.0:
        return "Rough", 2
    else:
        return "Danger", 3


def classify_wind(wind_speed):
    """
    Classify Wind Speed:
      0-20 km/h  -> Safe
      20-40 km/h -> Moderate
      Above 40 km/h -> Danger
    """
    if wind_speed <= 20.0:
        return "Safe", 0
    elif wind_speed <= 40.0:
        return "Moderate", 1
    else:
        return "Danger", 3


def analyze_route_safety(weather_points, total_distance_km=0.0):
    """
    Analyze sampled weather points and calculate Route Safety Score with detailed itemized Risk Analysis.

    Args:
        weather_points (list): Enriched weather points from weather_engine.
        total_distance_km (float): Total route distance in kilometers.

    Returns:
        dict: {
            'analyzed_points': list,
            'summary': { ... },
            'safety_score': int,    # 0 - 100
            'safety_rating': str,   # Perfect, Good, Moderate, Danger, Very Dangerous
            'total_risk': int,
            'risk_breakdown': list of dicts [{ 'label': str, 'value': str, 'points': int }]
        }
    """
    if not weather_points:
        return {
            'analyzed_points': [],
            'summary': {
                'avg_wave_height': 0.0,
                'max_wave_height': 0.0,
                'avg_wind_speed': 0.0,
                'max_wind_speed': 0.0,
                'safe_points_count': 0,
                'moderate_points_count': 0,
                'rough_points_count': 0,
                'danger_points_count': 0
            },
            'safety_score': 100,
            'safety_rating': "Perfect",
            'total_risk': 0,
            'risk_breakdown': []
        }

    total_waves = [p['wave_height'] for p in weather_points]
    total_winds = [p['wind_speed'] for p in weather_points]

    avg_wave = sum(total_waves) / len(total_waves)
    max_wave = max(total_waves)
    avg_wind = sum(total_winds) / len(total_winds)
    max_wind = max(total_winds)

    analyzed_points = []
    safe_cnt = 0
    mod_cnt = 0
    rough_cnt = 0
    danger_cnt = 0

    for pt in weather_points:
        wave_status, wave_sev = classify_wave(pt['wave_height'])
        wind_status, wind_sev = classify_wind(pt['wind_speed'])

        max_sev = max(wave_sev, wind_sev)
        if max_sev == 0:
            point_status = "Safe"
            safe_cnt += 1
        elif max_sev == 1:
            point_status = "Moderate"
            mod_cnt += 1
        elif max_sev == 2:
            point_status = "Rough"
            rough_cnt += 1
        else:
            point_status = "Danger"
            danger_cnt += 1

        analyzed_pt = dict(pt)
        analyzed_pt['wave_status'] = wave_status
        analyzed_pt['wind_status'] = wind_status
        analyzed_pt['point_status'] = point_status
        analyzed_points.append(analyzed_pt)

    # ── Detailed Itemized Risk Analysis ─────────────────────────────────────────
    risk_items = []

    # 1. Wave Height Risk
    if max_wave > 3.5:
        wave_risk = 35
    elif max_wave > 2.5:
        wave_risk = 25
    elif max_wave > 1.5:
        wave_risk = 15
    elif max_wave > 0.5:
        wave_risk = 5
    else:
        wave_risk = 0
    risk_items.append({'label': 'Wave Height', 'value': f"{max_wave:.2f} m", 'points': wave_risk})

    # 2. Wind Speed Risk
    if max_wind > 40.0:
        wind_risk = 25
    elif max_wind > 30.0:
        wind_risk = 15
    elif max_wind > 20.0:
        wind_risk = 10
    else:
        wind_risk = 0
    risk_items.append({'label': 'Wind Speed', 'value': f"{max_wind:.1f} km/h", 'points': wind_risk})

    # 3. Travel Distance Risk
    dist_val = total_distance_km or (weather_points[-1]['distance_km'] if weather_points else 0)
    if dist_val > 700:
        dist_risk = 15
    elif dist_val > 400:
        dist_risk = 10
    elif dist_val > 200:
        dist_risk = 5
    else:
        dist_risk = 0
    risk_items.append({'label': 'Travel Distance', 'value': f"{dist_val:.0f} km", 'points': dist_risk})

    # 4. Night Navigation
    risk_items.append({'label': 'Night Navigation', 'value': '', 'points': 10})

    # 5. High Fuel Consumption
    fuel_risk = 5 if dist_val > 300 else 0
    risk_items.append({'label': 'High Fuel Consumption', 'value': '', 'points': fuel_risk})

    # 6. No Alternate Port Nearby
    risk_items.append({'label': 'No Alternate Port Nearby', 'value': '', 'points': 5})

    total_risk = sum(item['points'] for item in risk_items)
    final_score = int(round(max(0, min(100, 100 - total_risk))))

    if final_score >= 90:
        rating = "Perfect"
    elif final_score >= 75:
        rating = "Good"
    elif final_score >= 55:
        rating = "Moderate"
    elif final_score >= 35:
        rating = "Danger"
    else:
        rating = "Very Dangerous"

    return {
        'analyzed_points': analyzed_points,
        'summary': {
            'avg_wave_height': round(avg_wave, 2),
            'max_wave_height': round(max_wave, 2),
            'avg_wind_speed': round(avg_wind, 1),
            'max_wind_speed': round(max_wind, 1),
            'safe_points_count': safe_cnt,
            'moderate_points_count': mod_cnt,
            'rough_points_count': rough_cnt,
            'danger_points_count': danger_cnt
        },
        'safety_score': final_score,
        'safety_rating': rating,
        'total_risk': total_risk,
        'risk_breakdown': risk_items
    }
