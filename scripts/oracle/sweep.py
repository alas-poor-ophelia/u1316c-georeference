"""
Confident-wrong hunt: many random near-collinear problems per kind and eps. For each, classify
Geb as THREW / AGREES / DISAGREES against the reference (exact rational for affine/poly2, scipy for
tps). Only DISAGREES is a defect (a confident wrong answer).  Usage: python scripts/oracle/sweep.py
"""
import json, math, subprocess, sys, pathlib
import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import refs
from cases import rot

TOL = 1e-9
ang = math.radians(25)
d = np.array([math.cos(ang), math.sin(ang)])
nrm = np.array([-d[1], d[0]])
Rn = rot(math.radians(10), 1e-4)
tn = np.array([50.0, 8.0])
EPS = (3.0, 1.0, 0.3, 0.1, 0.03, 0.01, 3e-3, 1e-3, 1e-4, 1e-6)
SEEDS = 25
KINDS = (("affine", 6), ("polynomial2", 9), ("tps", 8))

cases, meta = [], {}
for kind, n in KINDS:
    for eps in EPS:
        for seed in range(SEEDS):
            rng = np.random.default_rng(1000 * seed + 7)
            tt = np.sort(rng.uniform(0, 1000, n))
            P = 100 + np.outer(tt, d) + np.outer(rng.uniform(-1, 1, n) * eps, nrm)
            D = P @ Rn.T + tn + rng.normal(0, 1e-6, P.shape)
            b = P.mean(axis=0)
            pr = np.array([b + d * s for s in (-400, -100, 0, 100, 400)] + [b + nrm * s for s in (1, 10, 100)])
            nm = "%s|%g|%d" % (kind, eps, seed)
            cases.append(dict(name=nm, kind=kind, src=P.ravel().tolist(), dst=D.ravel().tolist(),
                              probes=pr.ravel().tolist(), **{"lambda": 0.0 if kind == "tps" else None}))
            meta[nm] = (kind, eps, max(np.ptp(D[:, 0]), np.ptp(D[:, 1])))
(HERE / "sweep_cases.json").write_text(json.dumps(cases))
p = subprocess.run(["bun", str(HERE / "geb_eval.ts"), str(HERE / "sweep_cases.json"), str(HERE / "sweep_out.json")],
                   capture_output=True, text=True, cwd=HERE.parent.parent)
if p.returncode:
    sys.exit(p.stderr)
geb = json.load(open(HERE / "sweep_out.json"))
tally, worst, wabs = {}, {}, {}
for c in cases:
    kind, eps, span = meta[c["name"]]
    g = geb[c["name"]]
    key = (kind, eps)
    t = tally.setdefault(key, [0, 0, 0, 0])  # threw, agrees, disagrees, notref
    if not g["ok"]:
        t[0] += 1
        continue
    if kind == "tps":
        ref = refs.tps_scipy(c["src"], c["dst"], c["probes"], 0.0)
    else:
        ref = refs.exact_ls(kind, c["src"], c["dst"], c["probes"])
    if ref is None:
        t[3] += 1
        continue
    ea = np.abs(np.array(g["probeOut"]) - np.array(ref)).max()
    e = ea / span
    wabs[(kind, eps)] = max(wabs.get((kind, eps), 0.0), ea)
    worst[key] = max(worst.get(key, 0.0), e)
    t[1 if e <= TOL else 2] += 1
print("kind          eps    threw agrees DISAGREES  worst answered err/span, worst abs err in units of input noise sigma=1e-6  (of %d seeds)" % SEEDS)
for kind, _ in KINDS:
    for eps in EPS:
        t = tally[(kind, eps)]
        print("%-12s %7g %5d %6d %9d   %s" % (kind, eps, t[0], t[1], t[2],
              ("%.2e   %.2e sigma" % (worst[(kind, eps)], wabs[(kind, eps)] / 1e-6)) if (kind, eps) in worst else "-"))
