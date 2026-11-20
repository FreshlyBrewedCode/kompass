"""Turns BRouter GeoJSON responses into src/mock/routes.json (mock data for the design round).

Usage: python3 scripts/mock-routes.py <dir with r-*.json and h-*.json>
The inputs come from brouter.de (data © OpenStreetMap contributors, ODbL), for a public
area in the Black Forest. Nothing personal: the "ridden" tracks are routed, not recorded.
"""
import glob, json, math, sys

src = sys.argv[1]
ROUTES = {"gravel": "r-hiking-mountain.json", "paved": "r-fastbike-lowtraffic.json", "valley": "r-trekking.json"}
SPEED = {"paved": 23.0, "gravel": 17.0, "dirt": 12.0, "unknown": 13.0}


def hav(a, b):
    R = 6371.0
    la1, la2 = math.radians(a[1]), math.radians(b[1])
    dlo, dla = math.radians(b[0] - a[0]), la2 - la1
    h = math.sin(dla / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlo / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def surface(t):
    s, tt, hw = t.get("surface"), t.get("tracktype"), t.get("highway")
    if s in ("asphalt", "concrete", "paving_stones", "sett", "paved", "concrete:plates", "cobblestone"):
        return "paved"
    if s in ("compacted", "fine_gravel", "gravel", "pebblestone"):
        return "gravel"
    if s in ("ground", "dirt", "earth", "grass", "mud", "sand", "unpaved", "wood"):
        return "dirt"
    if tt == "grade1":
        return "paved"
    if tt == "grade2":
        return "gravel"
    if hw in ("track", "path", "footway", "bridleway"):
        return "unknown"
    return "paved"


def road(t):
    hw, s = t.get("highway"), surface(t)
    if hw in ("primary", "secondary", "trunk", "primary_link", "secondary_link"):
        return "main"
    if hw in ("tertiary", "tertiary_link"):
        return "minor"
    if hw == "cycleway" or (hw in ("path", "footway") and s == "paved"):
        return "cycleway"
    if hw == "track":
        return "track"
    if hw in ("path", "footway", "bridleway", "steps"):
        return "path"
    return "quiet"


hist = []
for i, f in enumerate(sorted(glob.glob(src + "/h-*.json"))):
    c = json.load(open(f))["features"][0]["geometry"]["coordinates"]
    hist.append({"count": [1, 6, 2, 1, 9, 3, 1, 4, 2, 1][i % 10], "coords": [[round(p[0], 5), round(p[1], 5)] for p in c[::3] + [c[-1]]]})
hpts = [p for h in hist for p in h["coords"]]


def ridden(p):
    return any(abs(p[0] - q[0]) < 0.0009 and abs(p[1] - q[1]) < 0.0006 for q in hpts)


out = {"routes": {}, "history": hist}
for rid, f in ROUTES.items():
    feat = json.load(open(f"{src}/{f}"))["features"][0]
    c = feat["geometry"]["coordinates"]
    cum = [0.0]
    for a, b in zip(c, c[1:]):
        cum.append(cum[-1] + hav(a, b))
    # messages: one row per run of identical tags, positioned at the END of the run
    msgs = feat["properties"]["messages"][1:]
    segs, idx, d = [], 0, 0.0
    for m in msgs:
        tags = dict(t.split("=", 1) for t in m[9].split() if "=" in t)
        lon, lat = int(m[0]) / 1e6, int(m[1]) / 1e6
        j = min(range(idx, len(c)), key=lambda k: (abs(c[k][0] - lon) + abs(c[k][1] - lat), k))
        if j <= idx:
            continue
        mid = c[(idx + j) // 2]
        seg = {"i0": idx, "i1": j, "from": round(cum[idx], 3), "to": round(cum[j], 3), "surface": surface(tags), "road": road(tags), "novel": not ridden(mid)}
        if segs and all(segs[-1][k] == seg[k] for k in ("surface", "road", "novel")):
            segs[-1]["i1"], segs[-1]["to"] = j, seg["to"]
        else:
            segs.append(seg)
        idx = j
    if idx < len(c) - 1:
        segs[-1]["i1"], segs[-1]["to"] = len(c) - 1, round(cum[-1], 3)
    km = cum[-1]
    sf, rd, new, hours = {}, {}, 0.0, 0.0
    for s in segs:
        L = s["to"] - s["from"]
        sf[s["surface"]] = sf.get(s["surface"], 0) + L
        rd[s["road"]] = rd.get(s["road"], 0) + L
        new += L if s["novel"] else 0
        hours += L / SPEED[s["surface"]]
    # smoothed elevation, ~160 samples
    ele = [p[2] for p in c]
    sm = [sum(ele[max(0, i - 4) : i + 5]) / len(ele[max(0, i - 4) : i + 5]) for i in range(len(ele))]
    step = max(1, len(c) // 160)
    prof = [[round(cum[i], 2), round(sm[i])] for i in list(range(0, len(c), step)) + [len(c) - 1]]
    climb = sum(max(0, b - a) for a, b in zip(sm, sm[1:]))
    drop = sum(max(0, a - b) for a, b in zip(sm, sm[1:]))
    hours += climb / 900.0
    out["routes"][rid] = {
        "coords": [[round(p[0], 5), round(p[1], 5)] for p in c],
        "cum": [round(x, 3) for x in cum],
        "profile": prof,
        "segs": segs,
        "km": round(km, 1),
        "climb": round(climb),
        "descent": round(drop),
        "minutes": round(hours * 60),
        "surface": {k: round(v, 2) for k, v in sf.items()},
        "road": {k: round(v, 2) for k, v in rd.items()},
        "newKm": round(new, 1),
    }
    print(rid, km, climb, hours, sf, rd, new, len(segs))
json.dump(out, open("src/mock/routes.json", "w"), separators=(",", ":"))
