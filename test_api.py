import requests, json

# Simulate a ship at 13.08, 80.27 (Bay of Bengal / near Chennai)
SHIP_LAT, SHIP_LON, SHIP_SPEED = 13.08, 80.27, 15.0

print("=" * 60)
print("TEST: Emergency Nearest Ports")
print("=" * 60)
r = requests.post('http://127.0.0.1:5000/api/emergency/nearest_ports',
    json={'ship_lat': SHIP_LAT, 'ship_lon': SHIP_LON, 'limit': 5}, timeout=10)
data = r.json()
ports = data.get('ports', [])
print(f"success={data.get('success')}, count={len(ports)}")
for i, p in enumerate(ports):
    print(f"  #{i+1}: {p['PORT_NAME']} ({p['COUNTRY']}) dist={p['distance_km']}km")

print()
print("=" * 60)
print("TEST: Route Analysis - Closest Port")
print("=" * 60)
dest = ports[0]
r2 = requests.post('http://127.0.0.1:5000/api/route_analysis',
    json={'ship_lat': SHIP_LAT, 'ship_lon': SHIP_LON,
          'dest_lat': float(dest['LATITUDE']), 'dest_lon': float(dest['LONGITUDE']),
          'ship_speed': SHIP_SPEED}, timeout=60)
data2 = r2.json()
print(f"success={data2.get('success')}")
coords = data2.get('coordinates', [])
print(f"coordinates count: {len(coords)}")
if coords:
    print(f"first coord: {coords[0]}")
    print(f"last coord:  {coords[-1]}")
print(f"total_distance_km: {data2.get('eta',{})}")
print(f"safety_score: {data2.get('safety_score')}")
print(f"safety_rating: {data2.get('safety_rating')}")
weather_pts = data2.get('sampled_weather', [])
print(f"sampled_weather points: {len(weather_pts)}")
error = data2.get('error')
if error:
    print(f"ERROR: {error}")

print()
print("=" * 60)
print("TEST: Route Analysis - 3rd Port (further)")
print("=" * 60)
dest3 = ports[2]
r3 = requests.post('http://127.0.0.1:5000/api/route_analysis',
    json={'ship_lat': SHIP_LAT, 'ship_lon': SHIP_LON,
          'dest_lat': float(dest3['LATITUDE']), 'dest_lon': float(dest3['LONGITUDE']),
          'ship_speed': SHIP_SPEED}, timeout=60)
data3 = r3.json()
print(f"success={data3.get('success')}")
coords3 = data3.get('coordinates', [])
print(f"coordinates count: {len(coords3)}")
print(f"safety_score: {data3.get('safety_score')}")
if data3.get('error'):
    print(f"ERROR: {data3.get('error')}")
print()
print("ALL TESTS PASSED" if (data.get('success') and data2.get('success') and len(coords) > 1 and data3.get('success') and len(coords3) > 1) else "SOME TESTS FAILED")
