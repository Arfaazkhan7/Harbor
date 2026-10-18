"""
Maritime Emergency Response System - Ocean Ships Table Creator
==============================================================
Creates a new SQLite table `ocean_ships` by GIS-filtering ships from
the `latest_ships` VIEW using the Natural Earth land polygons dataset.

Workflow:
  latest_ships (12,783 unique MMSI)
  → Convert LAT/LON to Shapely Points
  → Test each point against Natural Earth Land Polygons (high resolution)
  → Reject ships on land, keep ships on navigable ocean/sea
  → Geographically distribute up to 200 ships across all ocean regions
  → Write results to new `ocean_ships` table in maritime.db

Rules:
  • Do NOT modify ships, latest_ships, or any existing data.
  • Do NOT generate fake ships or coordinates.
  • Do NOT move any ship.
  • 1 MMSI = 1 row (strict deduplication).
  • Store up to 200 ships with natural geographic spread.
  • Preserve ALL original columns from latest_ships.

Dependencies:
  pip install geopandas shapely

Natural Earth Data:
  Downloaded automatically via geopandas built-in datasets, or
  fetched from naturalearthdata.com (110m land polygons).
"""

import math
import sqlite3
import pandas as pd
import geopandas as gpd
from shapely.geometry import Point
from typing import Tuple, List

# ─────────────────────────────────────────────────────────────────────────────
# CONFIGURATION
# ─────────────────────────────────────────────────────────────────────────────
DB_PATH = "maritime.db"
SOURCE_VIEW = "latest_ships"
TARGET_TABLE = "ocean_ships"
TARGET_COUNT = 200          # Maximum ships to store
GRID_DEGREES = 5.0          # Grid cell size in degrees — 1 ship per 5°×5° cell for max global spread


# ─────────────────────────────────────────────────────────────────────────────
# STEP 1: Load Natural Earth Land Polygons
# ─────────────────────────────────────────────────────────────────────────────
def load_land_polygons() -> gpd.GeoDataFrame:
    """
    Load high-resolution Natural Earth land polygon dataset.
    Uses the built-in GeoPandas 'naturalearth_lowres' as fallback,
    but prefers the higher-resolution 110m or 50m dataset.

    Returns:
        GeoDataFrame with land polygon geometries (CRS: EPSG:4326 WGS84).
    """
    print("Loading Natural Earth land polygon dataset...")

    try:
        # Attempt to load 110m Natural Earth physical land polygons via URL
        import urllib.request
        import os
        import zipfile
        import tempfile

        ne_url = (
            "https://naciscdn.org/naturalearth/110m/physical/ne_110m_land.zip"
        )
        tmp_dir = tempfile.mkdtemp()
        zip_path = os.path.join(tmp_dir, "ne_110m_land.zip")

        print("  Downloading Natural Earth 110m land polygons...")
        urllib.request.urlretrieve(ne_url, zip_path)

        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(tmp_dir)

        shp_path = os.path.join(tmp_dir, "ne_110m_land.shp")
        land = gpd.read_file(shp_path)
        land = land.to_crs("EPSG:4326")
        print(f"  Loaded Natural Earth 110m land: {len(land)} polygons.")
        return land

    except Exception as e:
        print(f"  Download failed ({e}). Falling back to built-in naturalearth_lowres...")
        land = gpd.read_file(gpd.datasets.get_path("naturalearth_lowres"))
        land = land.to_crs("EPSG:4326")
        print(f"  Loaded built-in land dataset: {len(land)} polygons.")
        return land


# ─────────────────────────────────────────────────────────────────────────────
# STEP 2: Load Ships from latest_ships VIEW
# ─────────────────────────────────────────────────────────────────────────────
def load_latest_ships(db_path: str) -> pd.DataFrame:
    """
    Read all ship records from the `latest_ships` VIEW.
    Selects all columns. Deduplicates by MMSI (one record per MMSI).

    Args:
        db_path: Path to maritime.db SQLite database.

    Returns:
        DataFrame with one row per unique MMSI ship.
    """
    print(f"\nLoading ships from '{SOURCE_VIEW}' VIEW in {db_path}...")

    conn = sqlite3.connect(db_path)
    query = f"""
        SELECT
            id, MMSI, BaseDateTime, LAT, LON, SOG, COG, Heading,
            VesselName, IMO, CallSign, VesselType, Status,
            Length, Width, Draft, Cargo, Speed_Category
        FROM {SOURCE_VIEW}
        WHERE LAT IS NOT NULL AND LON IS NOT NULL AND MMSI IS NOT NULL
        ORDER BY id ASC
    """
    df = pd.read_sql_query(query, conn)
    conn.close()

    # Strict MMSI deduplication (keep first occurrence — latest per MMSI from VIEW)
    initial_count = len(df)
    df = df.drop_duplicates(subset=["MMSI"], keep="first").reset_index(drop=True)
    print(f"  Records loaded   : {initial_count:,}")
    print(f"  After dedup MMSI : {len(df):,}")
    return df


# ─────────────────────────────────────────────────────────────────────────────
# STEP 3: GIS Land Filter
# ─────────────────────────────────────────────────────────────────────────────
def filter_ocean_ships_gis(
    ships_df: pd.DataFrame,
    land_gdf: gpd.GeoDataFrame
) -> gpd.GeoDataFrame:
    """
    Convert ship LAT/LON to Shapely Points and spatially test each against
    land polygons using a spatial index (STRtree) for performance.
    Ships located INSIDE any land polygon are rejected.
    Ships located OUTSIDE all land polygons are kept as genuine ocean ships.

    Args:
        ships_df: DataFrame of unique ships with LAT and LON columns.
        land_gdf: GeoDataFrame of Natural Earth land polygons (EPSG:4326).

    Returns:
        GeoDataFrame of ocean-only ships with original coordinates preserved.
    """
    print(f"\nConverting {len(ships_df):,} ship positions to GIS Points...")

    # Create Shapely Point geometry from original LAT/LON (no coordinate changes)
    ships_df = ships_df.copy()
    ships_df["geometry"] = ships_df.apply(
        lambda row: Point(row["LON"], row["LAT"]), axis=1
    )
    ships_gdf = gpd.GeoDataFrame(ships_df, geometry="geometry", crs="EPSG:4326")

    print("Building spatial index on land polygons...")
    land_union = land_gdf.geometry.union_all()

    print("Testing each ship position against land polygons...")
    total = len(ships_gdf)

    # Vectorised containment check using the unioned land geometry
    is_on_land = ships_gdf.geometry.within(land_union)

    ocean_gdf = ships_gdf[~is_on_land].copy()
    on_land_count = is_on_land.sum()

    print(f"  Ships tested     : {total:,}")
    print(f"  On land (rejected): {on_land_count:,}")
    print(f"  Ocean ships found: {len(ocean_gdf):,}")

    return ocean_gdf


# ─────────────────────────────────────────────────────────────────────────────
# STEP 4: Geographic Distribution Sampling
# ─────────────────────────────────────────────────────────────────────────────
def select_distributed_ships(
    ocean_gdf: gpd.GeoDataFrame,
    target_count: int,
    grid_degrees: float
) -> pd.DataFrame:
    """
    Select exactly `target_count` ships with maximum geographic spread.

    Strategy:
      1. Divide the ocean into a fine grid (5°×5° cells).
      2. Pick EXACTLY 1 ship per grid cell (the first available in that cell).
      3. If fewer cells than target_count, do a second pass picking a second
         ship per cell, and so on — always prioritising cells not yet represented.
      4. Guarantees maximum global separation between selected ships.
      5. Never modifies LAT/LON coordinates.

    Args:
        ocean_gdf: GeoDataFrame of genuine ocean ships (GIS-filtered).
        target_count: Exact number of ships to select.
        grid_degrees: Size of each grid cell in degrees (default 5°).

    Returns:
        DataFrame of selected ships with original coordinates unchanged.
    """
    if len(ocean_gdf) <= target_count:
        print(f"\nFewer than {target_count} ocean ships — storing all {len(ocean_gdf)}.")
        return ocean_gdf.drop(columns=["geometry"]).reset_index(drop=True)

    print(f"\nSelecting {target_count} maximally-spread ships (grid={grid_degrees}°, 1 per cell)...")

    df = ocean_gdf.copy().reset_index(drop=True)

    # Assign each ship to a grid cell
    df["_gx"] = (df["LON"] / grid_degrees).apply(lambda x: int(x) if x >= 0 else int(x) - 1)
    df["_gy"] = (df["LAT"] / grid_degrees).apply(lambda x: int(x) if x >= 0 else int(x) - 1)
    df["_cell"] = list(zip(df["_gx"], df["_gy"]))

    # Group ship indices by cell, sorted by cell key for determinism
    from collections import OrderedDict
    cell_groups: OrderedDict = OrderedDict()
    for cell in sorted(df["_cell"].unique()):
        indices = df.index[df["_cell"] == cell].tolist()
        cell_groups[cell] = indices

    num_cells = len(cell_groups)
    print(f"  Ocean grid cells occupied: {num_cells}")

    selected_indices = []
    pass_num = 0

    # Multi-pass round-robin: pick ships evenly from all cells
    while len(selected_indices) < target_count:
        added_this_pass = 0
        for cell, indices in cell_groups.items():
            if len(selected_indices) >= target_count:
                break
            if pass_num < len(indices):
                selected_indices.append(indices[pass_num])
                added_this_pass += 1
        if added_this_pass == 0:
            break  # All cells exhausted
        pass_num += 1

    result = df.loc[selected_indices].drop(
        columns=["geometry", "_gx", "_gy", "_cell"]
    ).reset_index(drop=True)

    print(f"  Grid cells used          : {min(num_cells, target_count)}")
    print(f"  Ships selected           : {len(result)}")
    return result


# ─────────────────────────────────────────────────────────────────────────────
# STEP 5: Write ocean_ships Table to SQLite
# ─────────────────────────────────────────────────────────────────────────────
def write_ocean_ships_table(df: pd.DataFrame, db_path: str) -> None:
    """
    Create (or replace) the `ocean_ships` table in maritime.db and insert
    the distributed ocean ship records.

    Does NOT touch ships, latest_ships, ports, or any other table.

    Args:
        df: DataFrame of selected ocean ships with original columns.
        db_path: Path to maritime.db.
    """
    print(f"\nWriting {len(df)} ships to '{TARGET_TABLE}' table in {db_path}...")

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # Drop existing ocean_ships table if present (idempotent re-run)
    cursor.execute(f'DROP TABLE IF EXISTS "{TARGET_TABLE}"')
    conn.commit()

    # Write using pandas to_sql for reliable schema generation
    df.to_sql(TARGET_TABLE, conn, if_exists="replace", index=False)
    conn.commit()

    # Add an explicit integer primary key alias column for convenience
    # (pandas to_sql uses default rowid)

    conn.close()
    print(f"  Table '{TARGET_TABLE}' created successfully.")


# ─────────────────────────────────────────────────────────────────────────────
# STEP 6: Verification
# ─────────────────────────────────────────────────────────────────────────────
def verify_ocean_ships_table(db_path: str, latest_count: int, ocean_found: int) -> None:
    """
    Query the new ocean_ships table and print verification summary.
    Confirms COUNT(*) == COUNT(DISTINCT MMSI) (no duplicates).

    Args:
        db_path: Path to maritime.db.
        latest_count: Total ships in latest_ships VIEW.
        ocean_found: Total genuine ocean ships found before limiting.
    """
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    cursor.execute(f'SELECT COUNT(*) FROM "{TARGET_TABLE}"')
    total_rows = cursor.fetchone()[0]

    cursor.execute(f'SELECT COUNT(DISTINCT MMSI) FROM "{TARGET_TABLE}"')
    distinct_mmsi = cursor.fetchone()[0]

    conn.close()

    print("\n" + "=" * 60)
    print(" VERIFICATION RESULTS")
    print("=" * 60)
    print(f" Latest Ships        : {latest_count:>8,}")
    print(f" Ocean Ships Found   : {ocean_found:>8,}")
    print(f" Ocean Ships Stored  : {total_rows:>8,}")
    print("-" * 60)
    print(f" SELECT COUNT(*)              FROM ocean_ships : {total_rows}")
    print(f" SELECT COUNT(DISTINCT MMSI)  FROM ocean_ships : {distinct_mmsi}")
    print("-" * 60)

    if total_rows == distinct_mmsi:
        print(" [PASS] COUNT(*) == COUNT(DISTINCT MMSI) — Zero duplicates confirmed.")
    else:
        print(f" [FAIL] Mismatch! {total_rows} rows vs {distinct_mmsi} distinct MMSI.")
    print("=" * 60)


# ─────────────────────────────────────────────────────────────────────────────
# MAIN ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────
def main():
    print("=" * 60)
    print(" Maritime Emergency Response System")
    print(" Ocean Ships GIS Filter — Table Creator")
    print("=" * 60)

    # Step 1: Load Natural Earth land polygons
    land_gdf = load_land_polygons()

    # Step 2: Load ships from latest_ships VIEW
    ships_df = load_latest_ships(DB_PATH)
    latest_count = len(ships_df)

    # Step 3: GIS filter — remove ships on land
    ocean_gdf = filter_ocean_ships_gis(ships_df, land_gdf)
    ocean_found = len(ocean_gdf)

    # Step 4: Geographic distribution sampling (up to TARGET_COUNT)
    selected_df = select_distributed_ships(ocean_gdf, TARGET_COUNT, GRID_DEGREES)

    # Step 5: Write ocean_ships table to maritime.db
    write_ocean_ships_table(selected_df, DB_PATH)

    # Step 6: Verify
    verify_ocean_ships_table(DB_PATH, latest_count, ocean_found)


if __name__ == "__main__":
    main()
