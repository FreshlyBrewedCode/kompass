import sys
import numpy as np
sys.path.insert(0, "/tmp/spike60")
from grades import curve, H_LO, H_HI, tamed

E = np.load(sys.argv[1])
L = E["length_m"].astype(np.float64)
fo1 = E["forest_share"] / 100.0
H = E["my_hist"].astype(np.float32)
gv = np.arange(H_LO, H_HI + 1).astype(np.float64)
hl = np.maximum(H.sum(axis=1), 1e-6)
cv = curve(gv).astype(np.float32); cvb = curve(-gv).astype(np.float32)
truth = np.concatenate([(H @ cv) / hl, (H @ cvb) / hl])
LL = np.concatenate([L, L]); fo = np.concatenate([fo1, fo1])
asc = np.concatenate([E["ascent_fwd_m"], E["ascent_bwd_m"]]).astype(np.float64)
desc = np.concatenate([E["ascent_bwd_m"], E["ascent_fwd_m"]]).astype(np.float64)
mx = np.concatenate([E["max_grade_fwd_pct"], E["max_grade_bwd_pct"]]).astype(np.float64)
mxd = np.concatenate([E["max_grade_bwd_pct"], E["max_grade_fwd_pct"]]).astype(np.float64)

def split(asc, desc):
    tot = asc + desc
    us = asc / np.maximum(tot, 1e-6)
    g = tot / np.maximum(LL, 1) * 100
    v = us * curve(g) + (1 - us) * curve(-g)
    return np.where(tot < 1e-3, 1.0, v)

def hybrid(asc, desc, mx, mxd):
    # 50 m at the steeper of the two steepest (in its direction), the rest split
    w = np.minimum(50.0 / np.maximum(LL, 1), 1.0)
    up_wall = curve(mx) >= curve(-mxd)
    wall = np.where(up_wall, curve(mx), curve(-mxd))
    a2 = np.maximum(asc - np.where(up_wall, w * LL * mx / 100, 0), 0)
    d2 = np.maximum(desc - np.where(up_wall, 0, w * LL * mxd / 100), 0)
    tot = a2 + d2
    rest_len = np.maximum(LL * (1 - w), 1)
    us = a2 / np.maximum(tot, 1e-6)
    g = tot / rest_len * 100
    rest = np.where(tot < 1e-3, 1.0, us * curve(g) + (1 - us) * curve(-g))
    return w * wall + (1 - w) * rest

def stats(nm, v, m=None):
    m = np.ones_like(LL, bool) if m is None else m
    err = np.abs(np.log(v[m] / truth[m]))
    w = LL[m]
    print(f"| {nm} | {np.sum(err*w)/w.sum():.3f} | {np.sum(w[err>np.log(1.15)])/w.sum()*100:.1f} % | {np.sum(w[err>np.log(1.5)])/w.sum()*100:.1f} % |")

s = split(asc, desc); h = hybrid(asc, desc, mx, mxd)
print("| model | mean abs log error | off > 15 % | off > 50 % |\n|---|---:|---:|---:|")
for where, m in [("all", None), ("open (< 10 % forest)", fo < 0.1), ("forest (> 90 %)", fo > 0.9)]:
    stats(f"split, {where}", s, m)
    stats(f"split + steepest 50 m, {where}", h, m)
# truth spread itself: forest vs open, metres beyond the arc's own mean grade
print("\nhistogram mass more than 5 pts from the arc's net grade (share of length):")
net = E["my_net"]
dev = np.abs(gv[None, :] - net[:, None]) > 5
far = (H * dev).sum(axis=1) / hl
for where, m in [("open", fo1 < 0.1), ("forest", fo1 > 0.9)]:
    print(f"  {where}: {np.sum(far[m]*L[m])/L[m].sum()*100:.1f} %")
