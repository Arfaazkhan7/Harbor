"""
Backend Database Module - SQLite Interface for maritime.db
==========================================================
Handles connection and queries for Ports, Emergency Logs,
Journey Logs, and Alert Logs stored in SQLite.
"""

import os
import sqlite3
from typing import List, Dict, Any, Optional

DB_PATH = 'maritime.db'


def get_db_connection(db_path: str = DB_PATH) -> sqlite3.Connection:
    """Create a connection to SQLite database with Row factory enabled."""
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(db_path: str = DB_PATH) -> None:
    """
    Ensure required SQLite tables exist.
    Creates emergency_logs, journey_logs, and alert_logs tables if not present.
    """
    conn = get_db_connection(db_path)
    cursor = conn.cursor()

    # Emergency Logs Table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS emergency_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ship_mmsi TEXT,
            ship_name TEXT,
            latitude REAL,
            longitude REAL,
            emergency_type TEXT,
            details TEXT,
            status TEXT DEFAULT 'ACTIVE',
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Journey Logs Table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS journey_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ship_mmsi TEXT,
            ship_name TEXT,
            origin_port TEXT,
            destination_port TEXT,
            status TEXT DEFAULT 'IN_PROGRESS',
            start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
            end_time DATETIME
        )
    """)

    # Alert Logs Table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS alert_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            alert_type TEXT,
            message TEXT,
            severity TEXT DEFAULT 'INFO',
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)

    conn.commit()
    conn.close()


def get_ports(db_path: str = DB_PATH) -> List[Dict[str, Any]]:
    """Retrieve all world ports with valid coordinates from ports table."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()

    query = """
        SELECT 
            id,
            INDEX_NO,
            PORT_NAME,
            COUNTRY,
            LATITUDE,
            LONGITUDE,
            HARBORTYPE,
            HARBORSIZE,
            FUEL_OIL,
            DIESEL,
            ELECREPAIR,
            REPAIRCODE,
            MED_FACIL
        FROM ports
        WHERE LATITUDE IS NOT NULL AND LONGITUDE IS NOT NULL
    """
    try:
        cursor.execute(query)
        rows = cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def log_emergency(emergency_data: Dict[str, Any], db_path: str = DB_PATH) -> int:
    """Store emergency event inside SQLite emergency_logs table."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()

    query = """
        INSERT INTO emergency_logs (ship_mmsi, ship_name, latitude, longitude, emergency_type, details, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """
    cursor.execute(query, (
        emergency_data.get('ship_mmsi'),
        emergency_data.get('ship_name'),
        emergency_data.get('latitude'),
        emergency_data.get('longitude'),
        emergency_data.get('emergency_type', 'GENERAL'),
        emergency_data.get('details', ''),
        emergency_data.get('status', 'ACTIVE')
    ))
    conn.commit()
    inserted_id = cursor.lastrowid
    conn.close()
    return inserted_id


def get_emergency_logs(db_path: str = DB_PATH) -> List[Dict[str, Any]]:
    """Retrieve stored emergency logs."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM emergency_logs ORDER BY timestamp DESC")
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]


def log_journey(journey_data: Dict[str, Any], db_path: str = DB_PATH) -> int:
    """Store journey event inside SQLite journey_logs table."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()

    query = """
        INSERT INTO journey_logs (ship_mmsi, ship_name, origin_port, destination_port, status)
        VALUES (?, ?, ?, ?, ?)
    """
    cursor.execute(query, (
        journey_data.get('ship_mmsi'),
        journey_data.get('ship_name'),
        journey_data.get('origin_port'),
        journey_data.get('destination_port'),
        journey_data.get('status', 'IN_PROGRESS')
    ))
    conn.commit()
    inserted_id = cursor.lastrowid
    conn.close()
    return inserted_id


def get_journey_logs(db_path: str = DB_PATH) -> List[Dict[str, Any]]:
    """Retrieve stored journey logs."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM journey_logs ORDER BY start_time DESC")
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]


def log_alert(alert_data: Dict[str, Any], db_path: str = DB_PATH) -> int:
    """Store alert event inside SQLite alert_logs table."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()

    query = """
        INSERT INTO alert_logs (alert_type, message, severity)
        VALUES (?, ?, ?)
    """
    cursor.execute(query, (
        alert_data.get('alert_type', 'GENERAL'),
        alert_data.get('message', ''),
        alert_data.get('severity', 'INFO')
    ))
    conn.commit()
    inserted_id = cursor.lastrowid
    conn.close()
    return inserted_id


def get_alert_logs(db_path: str = DB_PATH) -> List[Dict[str, Any]]:
    """Retrieve stored alert logs."""
    conn = get_db_connection(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM alert_logs ORDER BY timestamp DESC")
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]
