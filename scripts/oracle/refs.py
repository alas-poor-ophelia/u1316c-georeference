"""
Reference implementations for the Geb oracle.  Nothing here imports Geb.
  * affine / polynomial2 : EXACT rational least squares (fractions.Fraction normal equations, zero
    rounding) on RAW real-unit coordinates, plus numpy.linalg.lstsq as a second opinion.
  * tps : scipy.interpolate.RBFInterpolator(kernel=thin_plate_spline, degree=1), plus a
    hand-assembled bordered system solved with numpy as a second opinion.
Outputs are final probe values in real units; coefficients are never compared.
"""
import math
from fractions import Fraction
import numpy as np
from scipy.interpolate import RBFInterpolator


def basis(kind, x, y):
    return [1, x, y] if kind == "affine" else [1, x, y, x * x, x * y, y * y]


def exact_ls(kind, src, dst, probes):
    """Exact least squares via Fraction normal equations. None if exactly singular."""
    n = len(src) // 2
    rows = [[Fraction(v) for v in basis(kind, Fraction(src[2 * i]), Fraction(src[2 * i + 1]))] for i in range(n)]
    p = len(rows[0])
    coefs = []
    for axis in (0, 1):
        y = [Fraction(dst[2 * i + axis]) for i in range(n)]
        M = [[sum(r[a] * r[b] for r in rows) for b in range(p)] + [sum(r[a] * yy for r, yy in zip(rows, y))]
             for a in range(p)]
        for c in range(p):
            piv = next((r for r in range(c, p) if M[r][c] != 0), None)
            if piv is None:
                return None
            M[c], M[piv] = M[piv], M[c]
            for r in range(p):
                if r != c and M[r][c] != 0:
                    f = M[r][c] / M[c][c]
                    M[r] = [a - f * b for a, b in zip(M[r], M[c])]
        coefs.append([M[i][p] / M[i][i] for i in range(p)])
    res = []
    for i in range(len(probes) // 2):
        b = basis(kind, Fraction(probes[2 * i]), Fraction(probes[2 * i + 1]))
        res.append(float(sum(c * v for c, v in zip(coefs[0], b))))
        res.append(float(sum(c * v for c, v in zip(coefs[1], b))))
    return res


def np_lstsq(kind, src, dst, probes):
    S = np.array(src).reshape(-1, 2)
    D = np.array(dst).reshape(-1, 2)
    P = np.array(probes).reshape(-1, 2)
    A = np.array([basis(kind, x, y) for x, y in S], float)
    c, *_ = np.linalg.lstsq(A, D, rcond=None)
    B = np.array([basis(kind, x, y) for x, y in P], float)
    return (B @ c).ravel().tolist()


def hartley(pts):
    c = pts.mean(axis=0)
    rms = math.sqrt(((pts - c) ** 2).sum(axis=1).mean())
    return c, (math.sqrt(2) / rms if rms > 0 else 1.0)


def _norm(src, dst, probes):
    S = np.array(src).reshape(-1, 2)
    D = np.array(dst).reshape(-1, 2)
    P = np.array(probes).reshape(-1, 2)
    cs, ss = hartley(S)
    cd, sd = hartley(D)
    return (S - cs) * ss, (D - cd) * sd, (P - cs) * ss, cd, sd


def tps_scipy(src, dst, probes, lam):
    """Normalisation is recomputed here independently so smoothing = lam/n is applied in the same
    space Geb applies it (diag of K, Hartley-normalised coordinates)."""
    Sn, Dn, Pn, cd, sd = _norm(src, dst, probes)
    n = len(Sn)
    f = RBFInterpolator(Sn, Dn, kernel="thin_plate_spline", degree=1, smoothing=lam / n)
    return (f(Pn) / sd + cd).ravel().tolist()


def tps_hand(src, dst, probes, lam):
    """Bordered system [[K + d I, P],[P^T, 0]], U(r) = r^2 ln r, d = lam/n, same normalised space."""
    Sn, Dn, Pn, cd, sd = _norm(src, dst, probes)
    n = len(Sn)

    def U(r):
        return np.where(r > 0, r * r * np.log(np.where(r > 0, r, 1.0)), 0.0)

    r = np.linalg.norm(Sn[:, None] - Sn[None], axis=2)
    A = np.zeros((n + 3, n + 3))
    A[:n, :n] = U(r) + (lam / n) * np.eye(n)
    A[:n, n] = 1
    A[:n, n + 1:] = Sn
    A[n, :n] = 1
    A[n + 1:, :n] = Sn.T
    rhs = np.zeros((n + 3, 2))
    rhs[:n] = Dn
    coef = np.linalg.solve(A, rhs)
    rp = np.linalg.norm(Pn[:, None] - Sn[None], axis=2)
    out = U(rp) @ coef[:n] + coef[n] + Pn @ coef[n + 1:]
    return (out / sd + cd).ravel().tolist()
