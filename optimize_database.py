"""
Maritime Emergency Response System - Database Optimizer
======================================================
This script creates performance optimization indexes on the `maritime.db` SQLite database:
1. Index on `ships` table for `MMSI` column (`idx_ships_mmsi`).
2. Composite index on `ships` table for (`LAT`, `LON`) columns (`idx_ships_lat_lon`).
3. Composite index on `ports` table for (`LATITUDE`, `LONGITUDE`) columns (`idx_ports_lat_lon`).

Requirements handled:
- Checks if index exists prior to creation to prevent duplication.
- Uses clear, descriptive index names.
- Commits transactions and prints success messages.
- Lists all indexes for verification upon completion.
- Does not modify any table schema or row data.
"""

import os
import sqlite3
from typing import List


def index_exists(conn: sqlite3.Connection, index_name: str) -> bool:
    """
    Check if an index with the specified name already exists in the database.
    
    :param conn: Active sqlite3 database connection
    :param index_name: Name of the index to check
    :return: True if index exists, False otherwise
    """
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='index' AND name=?", (index_name,))
    return cursor.fetchone() is not None


def create_index_if_not_exists(conn: sqlite3.Connection, index_name: str, table_name: str, columns: List[str]) -> bool:
    """
    Create an index on a table if it does not already exist.
    
    :param conn: Active sqlite3 database connection
    :param index_name: Meaningful name for the index
    :param table_name: Target table name
    :param columns: List of column names to index
    :return: True if created, False if it already existed
    """
    if index_exists(conn, index_name):
        print(f"[INFO] Index '{index_name}' already exists on table '{table_name}'. Skipping creation.")
        return False

    columns_str = ", ".join([f'"{col}"' for col in columns])
    create_sql = f'CREATE INDEX IF NOT EXISTS "{index_name}" ON "{table_name}" ({columns_str})'
    
    print(f"Creating index '{index_name}' on '{table_name}' ({', '.join(columns)})...")
    conn.execute(create_sql)
    conn.commit()
    print(f"[SUCCESS] Index '{index_name}' successfully created on table '{table_name}'.")
    return True


def list_available_indexes(conn: sqlite3.Connection) -> None:
    """
    Query and display all user-created indexes in the SQLite database for verification.
    
    :param conn: Active sqlite3 database connection
    """
    cursor = conn.cursor()
    cursor.execute(
        "SELECT name, tbl_name, sql FROM sqlite_master "
        "WHERE type='index' AND name NOT LIKE 'sqlite_%' "
        "ORDER BY tbl_name, name"
    )
    indexes = cursor.fetchall()

    print("\n==================================================")
    print(" Verification: All Database Indexes")
    print("==================================================")
    if not indexes:
        print("No user-created indexes found.")
    else:
        for idx_name, tbl_name, sql in indexes:
            print(f"- Index Name : {idx_name}")
            print(f"  Table Name : {tbl_name}")
            print(f"  SQL DDL    : {sql}")
            print("-" * 50)


def main():
    db_path = 'maritime.db'

    if not os.path.exists(db_path):
        raise FileNotFoundError(f"Database file '{db_path}' does not exist. Please run create_database.py first.")

    print("==================================================")
    print(" Maritime Emergency Response System Database Optimization")
    print("==================================================")

    conn = sqlite3.connect(db_path)
    try:
        # 1. Index on ships(MMSI)
        create_index_if_not_exists(
            conn=conn,
            index_name='idx_ships_mmsi',
            table_name='ships',
            columns=['MMSI']
        )

        # 2. Composite index on ships(LAT, LON)
        create_index_if_not_exists(
            conn=conn,
            index_name='idx_ships_lat_lon',
            table_name='ships',
            columns=['LAT', 'LON']
        )

        # 3. Composite index on ports(LATITUDE, LONGITUDE)
        create_index_if_not_exists(
            conn=conn,
            index_name='idx_ports_lat_lon',
            table_name='ports',
            columns=['LATITUDE', 'LONGITUDE']
        )

        # List all database indexes for verification
        list_available_indexes(conn)

    finally:
        conn.close()
        print("\nDatabase optimization completed successfully.")


if __name__ == '__main__':
    main()
