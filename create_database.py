"""
Maritime Emergency Response System - Database Creator & Importer
================================================================
This script imports ship and port CSV datasets into a SQLite database (maritime.db).

Tables created:
1. `ships` : Contains all columns from `ship/processed_AIS_dataset.csv` with auto primary key `id`.
2. `ports` : Contains all columns from `port/World_Port_Index.csv` with auto primary key `id`.

Requirements handled:
- Modular, clean, production-quality code.
- Automatic table creation preserving exact column names.
- Automatic primary key `id` (INTEGER PRIMARY KEY AUTOINCREMENT).
- Correct handling of NULL values (spaces, empty strings, NaNs -> SQL NULL).
- Total records verification and display of first 5 rows for both tables.
"""

import os
import sqlite3
import pandas as pd


def get_sqlite_type(dtype) -> str:
    """
    Map pandas column data type to appropriate SQLite storage class.
    
    :param dtype: pandas dtype object
    :return: SQLite type ('INTEGER', 'REAL', or 'TEXT')
    """
    dtype_str = str(dtype).lower()
    if 'int' in dtype_str:
        return 'INTEGER'
    elif 'float' in dtype_str:
        return 'REAL'
    else:
        return 'TEXT'


def create_table_schema(conn: sqlite3.Connection, table_name: str, df: pd.DataFrame) -> None:
    """
    Dynamically generate and execute DDL to create a table based on DataFrame columns
    with an auto-incrementing primary key 'id'.
    
    :param conn: Active sqlite3 database connection
    :param table_name: Name of the SQLite table to create
    :param df: pandas DataFrame containing sample data to derive column names and types
    """
    cursor = conn.cursor()
    cursor.execute(f'DROP TABLE IF EXISTS "{table_name}"')

    # Primary key column definition
    columns_ddl = ['"id" INTEGER PRIMARY KEY AUTOINCREMENT']

    # Generate column definition DDL preserving exact original column names
    for column in df.columns:
        sqlite_type = get_sqlite_type(df[column].dtype)
        columns_ddl.append(f'"{column}" {sqlite_type}')

    create_table_sql = f'CREATE TABLE "{table_name}" (\n  ' + ',\n  '.join(columns_ddl) + '\n)'
    cursor.execute(create_table_sql)
    conn.commit()


def import_csv_to_table(csv_path: str, table_name: str, conn: sqlite3.Connection, chunksize: int = 50000) -> int:
    """
    Read a CSV dataset into pandas DataFrame, automatically create SQLite table schema,
    and insert all records preserving original column names and NULL values.
    
    :param csv_path: File path to the CSV dataset
    :param table_name: Name of target table in SQLite
    :param conn: Active sqlite3 database connection
    :param chunksize: Number of rows per batch insertion chunk
    :return: Total number of records inserted
    """
    if not os.path.exists(csv_path):
        raise FileNotFoundError(f"CSV file not found at: {csv_path}")

    # Standard list of NA representations to correctly convert empty/space values into SQL NULL
    na_values = ['', ' ', '  ', '   ', 'NULL', 'null', 'N/A', 'NA', 'nan', 'NaN']

    print(f"Reading dataset: {csv_path} ...")
    
    # Read entire dataset or first chunk to derive schema
    df = pd.read_csv(csv_path, na_values=na_values, keep_default_na=True, low_memory=False)
    
    # Clean string column whitespace trailing/leading spaces if present
    for col in df.select_dtypes(include=['object', 'string']).columns:
        df[col] = df[col].astype(str).str.strip()
        df[col] = df[col].replace({'': None, 'nan': None, 'NaN': None, 'NULL': None, 'None': None})

    # Create table schema dynamically
    create_table_schema(conn, table_name, df)

    # Insert data in chunks for performance and reliability
    print(f"Importing {len(df):,} records into table '{table_name}' ...")
    df.to_sql(table_name, conn, if_exists='append', index=False, chunksize=chunksize)
    conn.commit()

    # Query inserted row count directly from SQLite
    cursor = conn.cursor()
    cursor.execute(f'SELECT COUNT(*) FROM "{table_name}"')
    inserted_count = cursor.fetchone()[0]
    
    return inserted_count


def display_first_five_rows(conn: sqlite3.Connection, table_name: str) -> None:
    """
    Verify table data by querying and displaying the first five rows using pandas.
    
    :param conn: Active sqlite3 database connection
    :param table_name: Target table to inspect
    """
    print(f"\n==================================================")
    print(f" First 5 Rows Verification: Table '{table_name}'")
    print(f"==================================================")
    
    query = f'SELECT * FROM "{table_name}" LIMIT 5'
    sample_df = pd.read_sql_query(query, conn)
    
    # Set pandas display options to view all columns clearly
    pd.set_option('display.max_columns', None)
    pd.set_option('display.width', 1000)
    
    print(sample_df)
    print(f"\nTotal columns displayed: {len(sample_df.columns)}")


def main():
    # Database path
    db_name = 'maritime.db'
    
    # CSV Dataset paths
    ship_csv = os.path.join('ship', 'processed_AIS_dataset.csv')
    port_csv = os.path.join('port', 'World_Port_Index.csv')

    print("==================================================")
    print(" Maritime Emergency Response System Database Setup")
    print("==================================================")
    
    # Connect to SQLite database
    conn = sqlite3.connect(db_name)

    try:
        # Import Ships Dataset
        ships_count = import_csv_to_table(ship_csv, 'ships', conn)

        # Import Ports Dataset
        ports_count = import_csv_to_table(port_csv, 'ports', conn)

        # Summary Output Requirements
        print("\n--------------------------------------------------")
        print(" Import Summary")
        print("--------------------------------------------------")
        print(f"Ships imported: {ships_count:,}")
        print(f"Ports imported: {ports_count:,}")

        # Verification: Display first 5 rows of both tables
        display_first_five_rows(conn, 'ships')
        display_first_five_rows(conn, 'ports')

    finally:
        conn.close()
        print(f"\nDatabase successfully saved as '{db_name}'.")


if __name__ == '__main__':
    main()
