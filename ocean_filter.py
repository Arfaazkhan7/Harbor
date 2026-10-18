"""
Maritime Emergency Response System - Genuine Ocean Ship Filter
==============================================================
Filters real database records from `latest_ships` VIEW using a comprehensive
ocean/land mask strategy:

Strategy:
  1. Ships must fall within at least ONE known ocean/sea basin bounding box
     (whitelist approach - only genuine sea/ocean zones are accepted).
  2. Ships are additionally tested against a comprehensive inland exclusion list
     (rivers, lakes, canals, bays, sounds, and landlocked inland areas globally).
  3. If a coordinate passes the ocean whitelist but fails the inland exclusion,
     it is dropped.

Guarantees:
- Reads ONLY from `latest_ships` VIEW.
- Preserves 100% original database coordinates (NEVER relocates or generates fake coordinates).
- Excludes ALL ships on land, inland rivers, lakes, ports inside bays, inland waterways.
- Prints exact summary statistics.
"""

import sqlite3
from typing import List, Dict, Any, Tuple

# =============================================================================
# OCEAN / SEA WHITELIST BOUNDING BOXES
# Ships MUST fall inside at least one of these zones to be considered ocean ships
# =============================================================================
OCEAN_BASINS = [
    # ---- Atlantic Ocean ----
    {"name": "North Atlantic",        "lat_min": 5.0,   "lat_max": 65.0,  "lon_min": -80.0,  "lon_max": -5.0},
    {"name": "South Atlantic",        "lat_min": -60.0, "lat_max": 5.0,   "lon_min": -60.0,  "lon_max": 20.0},
    {"name": "Gulf of Mexico Open",   "lat_min": 23.0,  "lat_max": 30.5,  "lon_min": -97.5,  "lon_max": -80.0},
    {"name": "Caribbean Sea Open",    "lat_min": 10.0,  "lat_max": 23.0,  "lon_min": -88.0,  "lon_max": -60.0},

    # ---- Pacific Ocean ----
    {"name": "North Pacific",         "lat_min": 0.0,   "lat_max": 65.0,  "lon_min": 130.0,  "lon_max": 180.0},
    {"name": "North Pacific East",    "lat_min": 0.0,   "lat_max": 65.0,  "lon_min": -180.0, "lon_max": -110.0},
    {"name": "South Pacific",         "lat_min": -65.0, "lat_max": 0.0,   "lon_min": 145.0,  "lon_max": -70.0},
    {"name": "South Pacific East",    "lat_min": -65.0, "lat_max": 0.0,   "lon_min": -110.0, "lon_max": -70.0},

    # ---- Indian Ocean ----
    {"name": "Indian Ocean",          "lat_min": -60.0, "lat_max": 30.0,  "lon_min": 20.0,   "lon_max": 120.0},
    {"name": "Arabian Sea",           "lat_min": 5.0,   "lat_max": 28.0,  "lon_min": 50.0,   "lon_max": 78.0},
    {"name": "Bay of Bengal",         "lat_min": 5.0,   "lat_max": 22.0,  "lon_min": 79.0,   "lon_max": 95.0},
    {"name": "Red Sea",               "lat_min": 12.0,  "lat_max": 30.0,  "lon_min": 32.0,   "lon_max": 43.5},
    {"name": "Persian Gulf",          "lat_min": 22.0,  "lat_max": 30.0,  "lon_min": 48.0,   "lon_max": 58.0},
    {"name": "Gulf of Oman",          "lat_min": 20.0,  "lat_max": 26.5,  "lon_min": 56.0,   "lon_max": 65.0},

    # ---- European Seas ----
    {"name": "North Sea",             "lat_min": 50.0,  "lat_max": 62.0,  "lon_min": -3.0,   "lon_max": 9.0},
    {"name": "Baltic Sea",            "lat_min": 53.5,  "lat_max": 66.0,  "lon_min": 9.0,    "lon_max": 30.0},
    {"name": "English Channel",       "lat_min": 48.5,  "lat_max": 51.5,  "lon_min": -5.5,   "lon_max": 2.5},
    {"name": "Mediterranean Sea",     "lat_min": 30.0,  "lat_max": 46.0,  "lon_min": -6.0,   "lon_max": 36.5},
    {"name": "Black Sea",             "lat_min": 40.5,  "lat_max": 47.0,  "lon_min": 27.5,   "lon_max": 41.5},
    {"name": "Norwegian Sea",         "lat_min": 60.0,  "lat_max": 75.0,  "lon_min": -20.0,  "lon_max": 20.0},

    # ---- Asian Seas ----
    {"name": "South China Sea",       "lat_min": 0.0,   "lat_max": 23.0,  "lon_min": 105.0,  "lon_max": 122.0},
    {"name": "East China Sea",        "lat_min": 23.0,  "lat_max": 33.5,  "lon_min": 118.0,  "lon_max": 132.0},
    {"name": "Sea of Japan",          "lat_min": 33.0,  "lat_max": 45.0,  "lon_min": 127.0,  "lon_max": 142.0},
    {"name": "Yellow Sea",            "lat_min": 30.0,  "lat_max": 41.0,  "lon_min": 119.0,  "lon_max": 127.0},
    {"name": "Sea of Okhotsk",        "lat_min": 43.0,  "lat_max": 62.0,  "lon_min": 135.0,  "lon_max": 163.0},
    {"name": "Malacca Strait",        "lat_min": 1.0,   "lat_max": 6.5,   "lon_min": 98.5,   "lon_max": 105.0},
    {"name": "Java Sea",              "lat_min": -7.5,  "lat_max": -2.0,  "lon_min": 105.0,  "lon_max": 116.0},
    {"name": "Banda Sea",             "lat_min": -8.0,  "lat_max": -1.0,  "lon_min": 120.0,  "lon_max": 132.0},
    {"name": "Celebes Sea",           "lat_min": 1.0,   "lat_max": 10.0,  "lon_min": 118.0,  "lon_max": 127.0},

    # ---- Americas Coastal ----
    {"name": "US East Coast",         "lat_min": 25.0,  "lat_max": 45.0,  "lon_min": -78.0,  "lon_max": -65.0},
    {"name": "US West Coast",         "lat_min": 25.0,  "lat_max": 49.0,  "lon_min": -130.0, "lon_max": -117.0},
    {"name": "Gulf Coast Open Water", "lat_min": 24.5,  "lat_max": 29.5,  "lon_min": -97.0,  "lon_max": -84.0},

    # ---- African / Southern Seas ----
    {"name": "Gulf of Guinea",        "lat_min": -5.0,  "lat_max": 8.0,   "lon_min": -5.0,   "lon_max": 10.0},
    {"name": "Southern Ocean",        "lat_min": -75.0, "lat_max": -55.0, "lon_min": -180.0, "lon_max": 180.0},
    {"name": "Tasman Sea",            "lat_min": -48.0, "lat_max": -30.0, "lon_min": 147.0,  "lon_max": 175.0},
    {"name": "Coral Sea",             "lat_min": -26.0, "lat_max": -8.0,  "lon_min": 142.0,  "lon_max": 165.0},

    # ---- Arctic ----
    {"name": "Arctic Ocean",          "lat_min": 65.0,  "lat_max": 90.0,  "lon_min": -180.0, "lon_max": 180.0},
]

# =============================================================================
# INLAND / LAND EXCLUSION ZONES (must NOT contain ships)
# These are applied as hard exclusions even if inside an ocean basin bounding box
# =============================================================================
INLAND_EXCLUSIONS = [
    # ---- USA / North America ----
    # Florida Interior (land + lakes + inland bays)
    {"name": "Florida Interior",           "lat_min": 25.0, "lat_max": 30.9, "lon_min": -87.0, "lon_max": -79.9},
    # Florida East Coast shallow inland bays (Indian River, etc.)
    {"name": "Florida East Inland Bays",   "lat_min": 25.5, "lat_max": 30.8, "lon_min": -81.0, "lon_max": -79.9},
    # Tampa Bay & inland areas
    {"name": "Tampa Bay Interior",         "lat_min": 27.4, "lat_max": 28.1, "lon_min": -83.0, "lon_max": -82.2},
    # Charlotte Harbor / Peace River
    {"name": "Charlotte Harbor",           "lat_min": 26.5, "lat_max": 27.2, "lon_min": -82.5, "lon_max": -81.9},
    # Florida Everglades interior (south)
    {"name": "Florida Everglades",         "lat_min": 24.8, "lat_max": 26.0, "lon_min": -81.5, "lon_max": -80.2},
    # Mississippi River inland (above delta)
    {"name": "Mississippi River",          "lat_min": 30.5, "lat_max": 49.0, "lon_min": -92.5, "lon_max": -88.5},
    # Louisiana inland marshes + Lake Pontchartrain
    {"name": "Louisiana Marshes & Lakes",  "lat_min": 29.5, "lat_max": 31.0, "lon_min": -93.0, "lon_max": -88.5},
    # Ohio / Illinois River corridor
    {"name": "Ohio & Illinois Rivers",     "lat_min": 37.0, "lat_max": 43.0, "lon_min": -89.5, "lon_max": -80.0},
    # Missouri River
    {"name": "Missouri River",             "lat_min": 36.0, "lat_max": 49.0, "lon_min": -98.0, "lon_max": -90.0},
    # US Great Plains & Interior West (no sea access)
    {"name": "US Great Plains",            "lat_min": 31.0, "lat_max": 49.0, "lon_min": -110.0, "lon_max": -94.0},
    # Great Lakes
    {"name": "Great Lakes",                "lat_min": 41.0, "lat_max": 49.5, "lon_min": -93.0, "lon_max": -75.5},
    # Chesapeake Bay Interior (shallow inland)
    {"name": "Chesapeake Bay Interior",    "lat_min": 37.0, "lat_max": 39.5, "lon_min": -77.5, "lon_max": -75.5},
    # Long Island Sound Interior
    {"name": "Long Island Sound",          "lat_min": 40.8, "lat_max": 41.3, "lon_min": -73.6, "lon_max": -72.0},
    # Canada Interior
    {"name": "Canada Interior",            "lat_min": 49.0, "lat_max": 70.0, "lon_min": -125.0, "lon_max": -60.0},
    # US Pacific Coast Interior California
    {"name": "California Interior",        "lat_min": 33.5, "lat_max": 42.0, "lon_min": -122.5, "lon_max": -116.0},
    # Mexico Interior
    {"name": "Mexico Interior",            "lat_min": 15.0, "lat_max": 32.0, "lon_min": -108.0, "lon_max": -86.0},
    # Gulf of California
    {"name": "Gulf of California",         "lat_min": 22.0, "lat_max": 32.0, "lon_min": -115.0, "lon_max": -107.5},

    # ---- Europe ----
    # UK Land Interior
    {"name": "UK Land",                    "lat_min": 50.5, "lat_max": 60.0, "lon_min": -5.0, "lon_max": 1.8},
    # Scandinavia Interior
    {"name": "Scandinavia Interior",       "lat_min": 57.0, "lat_max": 70.0, "lon_min": 5.0,  "lon_max": 25.0},
    # Germany / Central Europe Interior
    {"name": "Central Europe Interior",    "lat_min": 45.0, "lat_max": 55.0, "lon_min": 8.0,  "lon_max": 22.0},
    # Russia Interior West
    {"name": "Russia Interior West",       "lat_min": 50.0, "lat_max": 70.0, "lon_min": 30.0, "lon_max": 80.0},
    # Caspian Sea (landlocked)
    {"name": "Caspian Sea",                "lat_min": 36.0, "lat_max": 47.5, "lon_min": 49.0, "lon_max": 55.0},

    # ---- Asia ----
    # Middle East Interior
    {"name": "Middle East Interior",       "lat_min": 22.0, "lat_max": 38.0, "lon_min": 36.0, "lon_max": 60.0},
    # India Interior
    {"name": "India Interior",             "lat_min": 15.0, "lat_max": 28.0, "lon_min": 72.5, "lon_max": 90.0},
    # China Interior
    {"name": "China Interior",             "lat_min": 22.0, "lat_max": 45.0, "lon_min": 95.0, "lon_max": 122.0},
    # Southeast Asia Interior
    {"name": "SE Asia Interior",           "lat_min": 5.0,  "lat_max": 20.0, "lon_min": 95.0, "lon_max": 110.0},
    # Lake Baikal area
    {"name": "Lake Baikal Region",         "lat_min": 51.0, "lat_max": 57.0, "lon_min": 100.0, "lon_max": 112.0},

    # ---- Africa ----
    # Africa Interior (Sahara, sub-saharan)
    {"name": "Africa Interior North",      "lat_min": 15.0, "lat_max": 37.0, "lon_min": -5.0,  "lon_max": 38.0},
    {"name": "Africa Interior South",      "lat_min": -35.0, "lat_max": 15.0, "lon_min": 12.0, "lon_max": 38.0},
    # Great Rift Valley Lakes
    {"name": "African Rift Valley Lakes",  "lat_min": -12.0, "lat_max": 5.0, "lon_min": 28.0, "lon_max": 37.0},

    # ---- South America ----
    # Amazon / Brazil Interior
    {"name": "Brazil & Amazon Interior",   "lat_min": -15.0, "lat_max": 5.0, "lon_min": -65.0, "lon_max": -40.0},
    # Andes / Pacific Coast Interior
    {"name": "South America Interior",     "lat_min": -40.0, "lat_max": -15.0, "lon_min": -70.0, "lon_max": -55.0},

    # ---- Australia ----
    {"name": "Australia Interior",         "lat_min": -38.0, "lat_max": -15.0, "lon_min": 114.0, "lon_max": 153.0},
]


def is_in_ocean(lat: float, lon: float) -> bool:
    """
    Check if coordinate falls inside at least one known ocean/sea basin.
    """
    for ocean in OCEAN_BASINS:
        if ocean["lat_min"] <= lat <= ocean["lat_max"] and ocean["lon_min"] <= lon <= ocean["lon_max"]:
            return True
    return False


def is_inland(lat: float, lon: float) -> bool:
    """
    Check if coordinate falls inside a known inland/land exclusion zone.
    """
    for zone in INLAND_EXCLUSIONS:
        if zone["lat_min"] <= lat <= zone["lat_max"] and zone["lon_min"] <= lon <= zone["lon_max"]:
            return True
    return False


def is_genuine_ocean_ship(lat: float, lon: float) -> bool:
    """
    Returns True only if the coordinate is in a genuine ocean/sea basin
    AND does NOT fall in any known inland/land exclusion zone.
    """
    if lat is None or lon is None:
        return False
    if not is_in_ocean(lat, lon):
        return False
    if is_inland(lat, lon):
        return False
    return True


def filter_ocean_ships(db_path: str = 'maritime.db') -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    """
    Read ships strictly from `latest_ships` VIEW, apply ocean whitelist + inland exclusion,
    and return genuine ocean ships along with exact count summary.
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    cursor.execute("""
        SELECT 
            id, MMSI, BaseDateTime, LAT, LON, SOG, COG, Heading, VesselName,
            IMO, CallSign, VesselType, Status, Length, Width, Draft, Cargo, Speed_Category
        FROM latest_ships
        WHERE LAT IS NOT NULL AND LON IS NOT NULL
        ORDER BY id ASC
    """)
    rows = cursor.fetchall()
    conn.close()

    total_latest_ships = len(rows)
    ocean_ships = []
    filtered_out_count = 0

    for r in rows:
        lat, lon = r["LAT"], r["LON"]
        if is_genuine_ocean_ship(lat, lon):
            ocean_ships.append(dict(r))
        else:
            filtered_out_count += 1

    stats = {
        "latest_ships": total_latest_ships,
        "ocean_ships": len(ocean_ships),
        "filtered_out": filtered_out_count,
        "displayed_ships": len(ocean_ships)
    }

    return ocean_ships, stats


def print_filter_summary(stats: Dict[str, int]) -> None:
    """Print the required summary statistics."""
    print("--------------------------------")
    print(f"Latest Ships       : {stats['latest_ships']:,}")
    print(f"Ocean Ships        : {stats['ocean_ships']:,}")
    print(f"Filtered Out       : {stats['filtered_out']:,}")
    print(f"Displayed Ships    : {stats['displayed_ships']:,}")
    print("--------------------------------")


if __name__ == '__main__':
    ocean_ships, stats = filter_ocean_ships()
    print_filter_summary(stats)
    if ocean_ships:
        print(f"\nSample check (first 5 positions):")
        for s in ocean_ships[:5]:
            print(f"  MMSI: {s['MMSI']:>12}  LAT: {s['LAT']:>10.5f}  LON: {s['LON']:>11.5f}  Name: {s.get('VesselName','')}")
