import requests, time

start = time.time()
r = requests.post('http://127.0.0.1:5000/api/emergency/nearest_ports',
    json={'ship_lat': 13.08, 'ship_lon': 80.27, 'limit': 5}, timeout=15)
t = time.time() - start
d = r.json()
print(f"nearest_ports: {t*1000:.0f}ms, success={d.get('success')}, count={len(d.get('ports',[]))}")
for i, p in enumerate(d.get('ports', [])):
    print(f"  #{i+1} {p['PORT_NAME']} {p['distance_km']}km")
