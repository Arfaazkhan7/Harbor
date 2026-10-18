"""
backend/route_engine.py
========================
Sea Route Generator & Sampler using `searoute`.

IMPORTANT: Straight-line fallback is COMPLETELY DISABLED.
If searoute returns < 3 coordinates or raises any exception this function
returns {'success': False, 'error': <reason>}.
The caller MUST try a different destination — never fabricate routes.
"""

import math
import logging
import searoute as sr

logger = logging.getLogger("RouteEngine")


def haversine_km(lat1, lon1, lat2, lon2):
    """Calculate the Great Circle distance between two points in km."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2) ** 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


def calculate_sea_route(origin_lat, origin_lon, dest_lat, dest_lon, sample_interval_km=25.0):
    """
    Generate a navigable sea route using the searoute library.

    Straight-line fallback is DISABLED. If searoute returns < 3 coordinates
    or raises any exception, this returns {'success': False, 'error': <reason>}.
    Never fabricates routes. Caller must try a different destination.

    Args:
        origin_lat (float): Ship latitude
        origin_lon (float): Ship longitude
        dest_lat (float): Destination port latitude
        dest_lon (float): Destination port longitude
        sample_interval_km (float): Sampling interval in km (default 25 km)

    Returns:
        dict: {
            'success': bool,
            'coordinates': [[lat, lon], ...],
            'total_distance_km': float,
            'total_distance_nm': float,
            'sampled_points': [{'lat', 'lon', 'distance_km', 'index'}, ...]
        }
        On failure: {'success': False, 'error': str}
    """
    try:
        # searoute expects [longitude, latitude]
        origin = [float(origin_lon), float(origin_lat)]
        dest   = [float(dest_lon),   float(dest_lat)]

        route = sr.searoute(origin, dest, units='km')

        if not route or 'geometry' not in route or 'coordinates' not in route['geometry']:
            return {
                'success': False,
                'error': 'searoute returned no geometry'
            }

        raw_coords    = route['geometry']['coordinates']  # [[lon, lat], ...]
        total_dist_km = float(route.get('properties', {}).get('length', 0.0))

        # Require ≥ 3 waypoints — fewer means searoute could not find a sea path
        if len(raw_coords) < 3:
            return {
                'success': False,
                'error': (f'searoute returned only {len(raw_coords)} coordinate(s) — '
                          f'rejected (minimum 3 required)')
            }

        # Convert [lon, lat] → [lat, lon] for Leaflet
        leaflet_coords = [[float(c[1]), float(c[0])] for c in raw_coords]

        # Cumulative distances along route segments
        cumulative_distances = [0.0]
        calc_total = 0.0
        for i in range(1, len(leaflet_coords)):
            p1 = leaflet_coords[i - 1]
            p2 = leaflet_coords[i]
            d = haversine_km(p1[0], p1[1], p2[0], p2[1])
            calc_total += d
            cumulative_distances.append(calc_total)

        if total_dist_km <= 0:
            total_dist_km = calc_total

        # ── Sample route every sample_interval_km ────────────────────────────
        sampled_points = [{
            'index': 0,
            'lat': leaflet_coords[0][0],
            'lon': leaflet_coords[0][1],
            'distance_km': 0.0
        }]

        next_sample_dist = sample_interval_km

        for i in range(1, len(leaflet_coords)):
            dist_i = cumulative_distances[i]

            while dist_i >= next_sample_dist and next_sample_dist < total_dist_km:
                prev_dist   = cumulative_distances[i - 1]
                segment_len = dist_i - prev_dist

                if segment_len > 0:
                    fraction   = (next_sample_dist - prev_dist) / segment_len
                    lat1, lon1 = leaflet_coords[i - 1]
                    lat2, lon2 = leaflet_coords[i]
                    interp_lat = lat1 + (lat2 - lat1) * fraction
                    interp_lon = lon1 + (lon2 - lon1) * fraction
                else:
                    interp_lat, interp_lon = leaflet_coords[i]

                sampled_points.append({
                    'index': len(sampled_points),
                    'lat': round(interp_lat, 5),
                    'lon': round(interp_lon, 5),
                    'distance_km': round(next_sample_dist, 2)
                })
                next_sample_dist += sample_interval_km

        # Always include the final destination
        last_coord = leaflet_coords[-1]
        if (not sampled_points or
                haversine_km(sampled_points[-1]['lat'], sampled_points[-1]['lon'],
                             last_coord[0], last_coord[1]) > 5.0):
            sampled_points.append({
                'index': len(sampled_points),
                'lat': round(last_coord[0], 5),
                'lon': round(last_coord[1], 5),
                'distance_km': round(total_dist_km, 2)
            })

        total_dist_nm = total_dist_km * 0.539957

        # IMPORTANT: Return the FULL raw searoute geometry as coordinates for rendering.
        # sampled_points are kept separately for weather analysis (every 25km).
        # Using only sampled_points previously caused zig-zag rendering with sparse waypoints.
        return {
            'success': True,
            'coordinates': leaflet_coords,   # Full dense geometry — never simplified
            'total_distance_km': round(total_dist_km, 2),
            'total_distance_nm': round(total_dist_nm, 2),
            'sampled_points': sampled_points
        }

    except Exception as e:
        logger.error(f"searoute exception ({origin_lat},{origin_lon})→({dest_lat},{dest_lon}): {e}")
        return {
            'success': False,
            'error': str(e)
        }
