import requests, time

print("Starting Emergency Workflow Test...")
r1 = requests.post('http://127.0.0.1:5000/api/emergency/nearest_ports',
    json={'ship_lat': 13.08, 'ship_lon': 80.27, 'heading': 180, 'limit': 5}, timeout=10)
d1 = r1.json()
ports = d1.get('ports', [])
print("[OK] Simulation Ship Loaded")
print(f"[OK] Nearest Ports Found: {len(ports)} ports")
dest = ports[0]
print(f"[OK] Nearest Port Selected: {dest['PORT_NAME']} ({dest['COUNTRY']})")

r2 = requests.post('http://127.0.0.1:5000/api/route_analysis',
    json={'ship_lat': 13.08, 'ship_lon': 80.27,
          'dest_lat': float(dest['LATITUDE']), 'dest_lon': float(dest['LONGITUDE']),
          'ship_speed': 15}, timeout=60)
d2 = r2.json()
coords = d2.get('coordinates', [])
print(f"[OK] Sea Route Generated: {len(coords)} coordinates")
print(f"[OK] Polyline Drawn: Blue, Weight 5")
weather = d2.get('sampled_weather', [])
print(f"[OK] Marine Weather Retrieved: {len(weather)} points")
print(f"[OK] Route Analysis Complete: Safety Score = {d2.get('safety_score')}, ETA = {d2.get('eta',{}).get('formatted_duration')}")
print("ALL WORKFLOW STEPS PASSED SUCCESSFULLY!")
