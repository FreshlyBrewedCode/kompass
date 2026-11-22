import sys, re, glob
def parse(path):
    rows = []; floor = {}
    for line in open(path):
        c = [x.strip() for x in line.strip().strip('|').split('|')]
        if len(c) == 8 and c[0] in ('gravel_explorer','paved_quiet','river_valley') and '%' in c[2]:
            floor[c[0]] = (c[2], c[3], c[4])
        if len(c) == 9 and c[0] in ('gravel_explorer','paved_quiet','river_valley') and re.match(r'^-?\d+$', c[2]):
            c = c[:6] + c[7:]
        if len(c) == 8 and c[0] in ('gravel_explorer','paved_quiet','river_valley') and re.match(r'^-?\d+$', c[2]):
            w = int(c[2]); v = lambda s: None if s == '—' else float(s.rstrip(' %'))
            rows.append((c[0], c[1], w, v(c[3]), v(c[4]), v(c[5]), v(c[6])))
    return rows, floor
models = sys.argv[2:]
print("| model | GE at floor | bonuses: nudge stronger / weaker (mean changed) | penalties: stronger / weaker | all nudges mean | extremes mean (to the other end / to the own end) |")
print("|---|---:|---:|---:|---:|---:|")
for m in models:
    rows, floor = parse(f"/tmp/spike60/{m}-{sys.argv[1]}.txt")
    bs, bw, ps, pw, allv, ext_o, ext_s = [], [], [], [], [], [], []
    for prof, pid, w, m100, wm, wp, p100 in rows:
        if pid in ('unpaved',) and prof == 'paved_quiet':
            pass
        stronger, weaker = (wp, wm) if w > 0 else (wm, wp)
        own, other = (p100, m100) if w > 0 else (m100, p100)
        (bs if w > 0 else ps).append(stronger) if stronger is not None else None
        (bw if w > 0 else pw).append(weaker) if weaker is not None else None
        for x in (wm, wp):
            if x is not None: allv.append(x)
        if other is not None: ext_o.append(other)
        if own is not None: ext_s.append(own)
    mean = lambda a: sum(a)/len(a) if a else float('nan')
    print(f"| {m} | {floor.get('gravel_explorer',('?',))[0]} | {mean(bs):.1f} / {mean(bw):.1f} % | {mean(ps):.1f} / {mean(pw):.1f} % | {mean(allv):.1f} % | {mean(ext_o):.0f} / {mean(ext_s):.0f} % |")
