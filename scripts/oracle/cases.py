"""Case construction (seeded, deterministic). build() returns a list of case dicts."""
import math
import numpy as np
import refs


def rot(theta, s):
    c, sn = math.cos(theta) * s, math.sin(theta) * s
    return np.array([[c, -sn], [sn, c]])


def grid(lo, hi, k=7):
    xs = np.linspace(lo[0], hi[0], k)
    ys = np.linspace(lo[1], hi[1], k)
    return [v for x in xs for y in ys for v in (x, y)]


def build():
    rng = np.random.default_rng(20261020)
    cases = []

    def add(name, kind, src, dst, probes, lam=None, truth=None, note="", direction=None):
        cases.append(dict(name=name, kind=kind, direction=direction, **{"lambda": lam},
                          src=np.asarray(src, float).ravel().tolist(),
                          dst=np.asarray(dst, float).ravel().tolist(),
                          probes=np.asarray(probes, float).ravel().tolist(), truth=truth, note=note))

    # 1. affine, 3 points, clean rotate+scale+translate
    R = rot(math.radians(30), 2.5e-4)
    t = np.array([48.0, 11.0])
    S = np.array([100, 200, 900, 250, 300, 800], float).reshape(-1, 2)
    pr = np.array(grid((0, 0), (1000, 1000))).reshape(-1, 2)
    add("1_affine_3pt_exact", "affine", S, S @ R.T + t, pr, truth=(pr @ R.T + t).ravel().tolist())

    # 2. affine, 12 points, noisy
    S = rng.uniform(0, 4000, (12, 2))
    D = S @ rot(math.radians(-17), 3e-4).T + [40.0, -105.0] + rng.normal(0, 2e-4, (12, 2))
    add("2_affine_12pt_noisy", "affine", S, D, grid((0, 0), (4000, 4000)))

    # 3. polynomial2
    def quad(P):
        P = np.asarray(P).reshape(-1, 2)
        x, y = P[:, 0] / 1000, P[:, 1] / 1000
        return np.stack([30 + 0.5 * x + 0.2 * y + 0.05 * x * x - 0.03 * x * y + 0.02 * y * y,
                         -80 + 0.1 * x - 0.4 * y + 0.01 * x * x + 0.04 * x * y - 0.06 * y * y], 1)

    pr = np.array(grid((0, 0), (1000, 1000)))
    S6 = rng.uniform(0, 1000, (6, 2))
    add("3a_poly2_6pt_exact", "polynomial2", S6, quad(S6), pr, truth=quad(pr).ravel().tolist())
    S15 = rng.uniform(0, 1000, (15, 2))
    add("3b_poly2_15pt_lsq", "polynomial2", S15, quad(S15) + rng.normal(0, 0.01, (15, 2)), pr)

    # 4/5. TPS, 8 points, nonlinear warp
    def warp(P):
        P = np.asarray(P).reshape(-1, 2)
        x, y = P[:, 0] / 1000, P[:, 1] / 1000
        return np.stack([10 + 2 * x + 0.3 * y + 0.4 * np.sin(3 * x) * np.cos(2 * y),
                         20 - 0.2 * x + 2 * y + 0.3 * np.cos(3 * y) * x], 1)

    S8 = np.array([[100, 120], [900, 80], [850, 900], [150, 880], [500, 500], [300, 300], [700, 650], [480, 950]], float)
    pr8 = grid((50, 50), (950, 950))
    add("4_tps_8pt_lambda0", "tps", S8, warp(S8), pr8, lam=0.0)
    D8 = warp(S8) + rng.normal(0, 0.02, (8, 2))
    for lam in (0.1, 1.0, 10.0):
        add(f"5_tps_8pt_lambda{lam:g}", "tps", S8, D8, pr8, lam=lam,
            note="reference smoothing diagonal = lambda/n in Hartley-normalised space")

    # 6. scale stress
    Sx = rng.uniform(0, 8000, (10, 2))
    Dx = np.stack([20.0 - 0.0075 * (Sx[:, 1] - 4000), 60.0 + 0.012 * (Sx[:, 0] - 4000)], 1) + rng.normal(0, 0.01, (10, 2))
    prx = grid((0, 0), (8000, 8000))
    add("6a_affine_8000px_continent", "affine", Sx, Dx, prx)
    add("6a2_poly2_8000px_continent", "polynomial2", Sx, Dx, prx)
    add("6a3_tps0_8000px_continent", "tps", Sx, Dx, prx, lam=0.0)
    St = rng.uniform(0, 500, (9, 2))
    Dt = np.stack([45.123456 - 2e-5 * (St[:, 1] - 250), -122.456789 + 2e-5 * (St[:, 0] - 250)], 1) + rng.normal(0, 2e-7, (9, 2))
    prt = grid((0, 0), (500, 500))
    add("6b_affine_500px_0.01deg", "affine", St, Dt, prt)
    add("6b2_poly2_500px_0.01deg", "polynomial2", St, Dt, prt)
    add("6b3_tps0_500px_0.01deg", "tps", St, Dt, prt, lam=0.0)
    Dt2 = Dt.copy()
    Dt2[:, 1] += 100.0
    add("6c_affine_500px_0.01deg_offset100", "affine", St, Dt2, prt)

    # 7. near-degenerate: points along a 25 degree line, perpendicular jitter of size eps (pixels)
    ang = math.radians(25)
    d = np.array([math.cos(ang), math.sin(ang)])
    nrm = np.array([-d[1], d[0]])

    def near_line(n, eps):
        tt = np.sort(rng.uniform(0, 1000, n))
        return 100 + np.outer(tt, d) + np.outer(rng.uniform(-1, 1, n) * eps, nrm)

    def probes7(P):
        b = P.mean(axis=0)
        return np.array([b + d * s for s in (-400, -100, 0, 100, 400)] + [b + nrm * s for s in (1, 10, 100)])

    Rn = rot(math.radians(10), 1e-4)
    tn = np.array([50.0, 8.0])
    for eps in (1.0, 0.3, 0.1, 0.03, 0.01, 3e-3, 1e-3, 1e-6, 1e-9, 1e-12):
        P = near_line(6, eps)
        add(f"7_affine_nearline_eps{eps:g}", "affine", P, P @ Rn.T + tn + rng.normal(0, 1e-6, P.shape), probes7(P))
    for eps in (1.0, 0.3, 0.1, 0.03, 0.01, 3e-3, 1e-3, 1e-6, 1e-9):
        P = near_line(8, eps)
        Dn = P @ Rn.T + tn + rng.normal(0, 1e-6, P.shape)
        add(f"7_poly2_nearline_eps{eps:g}", "polynomial2", P, Dn, probes7(P))
        add(f"7_tps0_nearline_eps{eps:g}", "tps", P, Dn, probes7(P), lam=0.0)

    # 8. mercator. Each fixture is a forward case (world [lat, lng] -> pixel) and a reverse case
    # (pixel -> world), because geb_eval fits one direction per case. World coordinates are
    # [lat, lng] pairs. The truth is the closed form in refs.py, never Geb. The data are exact under
    # the model, so Geb, the exact-rational reference and the truth must all agree.
    my = refs.merc_y

    def merc_case(tag, world, to_px, fwd_extra, rev_extra, note):
        """world: control points [lat, lng]; to_px(lat, lng) -> pixel; *_extra: worlds probed beyond
        the control points (forward) and pixels-by-world probed in reverse."""
        W = np.asarray(world, float).reshape(-1, 2)
        Px = np.array([to_px(la, ln) for la, ln in W])
        fprobe = np.vstack([W.mean(axis=0) + [[0.0, 0.0], [0.4, -0.7], [-0.5, 1.1]], np.asarray(fwd_extra, float)])
        add(f"8{tag}_mercator_fwd", "mercator", W, Px, fprobe, direction="forward",
            truth=np.array([to_px(la, ln) for la, ln in fprobe]).ravel().tolist(), note=note)
        rworld = np.vstack([fprobe[:3], np.asarray(rev_extra, float)])
        rpx = np.array([to_px(la, ln) for la, ln in rworld])
        add(f"8{tag}_mercator_rev", "mercator", Px, W, rpx, direction="reverse",
            truth=rworld.ravel().tolist(), note=note)

    # 8a. CLEAN_MERCATOR from test/fixtures.ts: eight British places under
    # px = (lng + 8) * 200, py = (my(60) - my(lat)) * 300.
    places = [(51.51, -0.13), (53.96, -1.08), (55.95, -3.19), (51.48, -3.18),
              (52.63, 1.3), (50.72, -3.53), (54.89, -2.93), (57.15, -2.09)]
    merc_case("a", places, lambda la, ln: ((ln + 8) * 200, (my(60) - my(la)) * 300),
              fwd_extra=[(84.0, -2.0)], rev_extra=[(88.0, -2.0)],
              note="CLEAN_MERCATOR shape. Forward probe (84, -2) is far beyond the control hull; its pixel "
                   "is (1200, -28047.58) (y = (my(60)-my(84))*300, above the 60 N origin). Reverse probe is the "
                   "pixel (1200, -46945.31) of (88, -2); it must unproject to lat 88 "
                   "(past the 85.05 control limit, inside the 89.9 evaluation limit).")

    # 8b. a 40-60 N band, 6 points, under a rotated and sheared affine in the projected plane:
    # [px, py] = M @ [my(lat), lng] + [500, 700], M = 40 * R(30 deg) @ [[1, 0.25], [0, 1]]
    # (30 degree rotation, 40 px/deg scale, 0.25 shear of the lng term into the y term).
    M = rot(math.radians(30), 40.0) @ np.array([[1.0, 0.25], [0.0, 1.0]])
    band = [(40.5, -10.0), (43.0, 4.0), (47.0, -4.0), (51.0, 8.0), (55.0, -1.0), (59.5, 12.0)]
    merc_case("b", band, lambda la, ln: tuple(M @ [my(la), ln] + [500.0, 700.0]),
              fwd_extra=[(84.0, 3.0)], rev_extra=[(88.0, 3.0)],
              note="band 40-60 N, affine M @ [my(lat), lng] + [500, 700], M = 40 R(30deg) [[1,.25],[0,1]]. "
                   "Forward probe (84, 3) -> pixel (6318.51, 4197.88); reverse probe pixel "
                   "(8500.64, 5457.73) must unproject to (88, 3).")
    return cases
