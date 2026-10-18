"""
Maritime Emergency Response System - Database View Creator & Verifier
====================================================================
This script creates the optimized SQL VIEW `latest_ships` on `maritime.db`.
It selects exactly ONE latest AIS telemetry record for every unique ship (MMSI)
based on MAX(BaseDateTime), while preserving all historical records in `ships`.
"""

import os
import sqlite3


def create_and_verify_latest_ships_view(db_path: str = 'maritime.db') -> None:
    """
    Create index idx_ships_mmsi_datetime and view latest_ships, then verify counts.
    
    :param db_path: Path to SQLite database file
    """
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"Database '{db_path}' not found. Please run create_database.py first.")

    print("==================================================")
    print(" Maritime Emergency Response System - View Setup")
    print("==================================================")

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    try:
        # Step 1: Create composite index for maximum view query performance
        print("\nCreating/Verifying composite index 'idx_ships_mmsi_datetime'...")
        cursor.execute('CREATE INDEX IF NOT EXISTS "idx_ships_mmsi_datetime" ON "ships" ("MMSI", "BaseDateTime" DESC);')
        conn.commit()

        # Step 2: Create SQL View `latest_ships`
        print("Creating SQL VIEW 'latest_ships'...")
        cursor.execute('DROP VIEW IF EXISTS "latest_ships";')
        
        create_view_sql = """
        CREATE VIEW "latest_ships" AS
        SELECT 
            id,
            MMSI,
            MAX(BaseDateTime) AS BaseDateTime,
            LAT,
            LON,
            SOG,
            COG,
            Heading,
            VesselName,
            IMO,
            CallSign,
            VesselType,
            Status,
            Length,
            Width,
            Draft,
            Cargo,
            Speed_Category
        FROM ships
        WHERE LAT IS NOT NULL AND LON IS NOT NULL AND MMSI IS NOT NULL
        GROUP BY MMSI;
        """
        cursor.execute(create_view_sql)
        conn.commit()
        print("[SUCCESS] VIEW 'latest_ships' successfully created.")

        # Step 3: Verification
        print("\n--------------------------------------------------")
        print(" Verification Results")
        print("--------------------------------------------------")

        cursor.execute('SELECT COUNT(*) FROM ships;')
        total_ships_records = cursor.fetchone()[0]

        cursor.execute('SELECT COUNT(DISTINCT MMSI) FROM ships WHERE LAT IS NOT NULL AND LON IS NOT NULL AND MMSI IS NOT NULL;')
        unique_mmsi_count = cursor.fetchone()[0]

        cursor.execute('SELECT COUNT(*) FROM latest_ships;')
        latest_ships_records = cursor.fetchone()[0]

        print(f"Total Records in ships            : {total_ships_records:,}")
        print(f"Unique MMSI in ships              : {unique_mmsi_count:,}")
        print(f"Total Records inside latest_ships : {latest_ships_records:,}")
        print("--------------------------------------------------")

        if latest_ships_records == unique_mmsi_count:
            print("[OK] VERIFICATION PASSED: latest_ships record count matches unique MMSI count exactly!")
        else:
            print("[WARNING] VERIFICATION WARNING: Count mismatch detected.")

    finally:
        conn.close()


if __name__ == '__main__':
    create_and_verify_latest_ships_view()
