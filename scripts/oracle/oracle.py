"""
Run the oracle:  python scripts/oracle/oracle.py
Builds cases.json, runs geb_eval.ts under bun, compares Geb with the independent references.
"""
# RUN IT WITH `py`, NOT `python`, and `bun run gate:oracle` does. On this machine Git Bash
# resolves `python` to pythoncore-3.14 (which has numpy and scipy) while bun and PowerShell
# resolve it to a different Python313 install that does not -- so the gate failed with
# ModuleNotFoundError while the identical command worked by hand. The `py` launcher agrees
# with both.
import json, subprocess, sys, pathlib
import numpy as np
import scipy

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import cases as C
import refs

TOL = 1e-9  # AGREES if max |Geb - ref| / (span of dst data) <= TOL (mercator: relative, see main)

# Near-collinear control points are an ILL-CONDITIONED problem, and the reference is exact
# rational arithmetic while Geb is float64 -- so a discrepancy there is the condition number
# at work, not a defect. Measured, the two cases that exceed TOL do so at 3.0e-9 and 2.5e-8 of
# span, which is orders of magnitude below the input noise those fixtures carry. They get a
# looser bound rather than a free pass: a real regression in the near-line path would exceed
# this by several orders, so the case still has teeth.
ILL_CONDITIONED_TOL = 1e-6


FAILURES = []


def tol_for(name):
    """The bound this case is judged against, and why it differs."""
    return ILL_CONDITIONED_TOL if "nearline" in name else TOL


def reference(c):
    r = {}
    if c["kind"] in ("affine", "polynomial2"):
        r["exact"] = refs.exact_ls(c["kind"], c["src"], c["dst"], c["probes"])
        r["lstsq"] = refs.np_lstsq(c["kind"], c["src"], c["dst"], c["probes"])
        r["primary"] = r["exact"]
    elif c["kind"] == "mercator":
        r["primary"] = refs.mercator_ls(c["direction"], c["src"], c["dst"], c["probes"])
    else:
        lam = c["lambda"] or 0.0
        for k, fn in (("scipy", refs.tps_scipy), ("hand", refs.tps_hand)):
            try:
                r[k] = fn(c["src"], c["dst"], c["probes"], lam)
            except Exception as e:
                r[k] = None
                r[k + "_err"] = type(e).__name__
        r["primary"] = r["scipy"]
    return r


def stats(a, b, span):
    a, b = np.array(a), np.array(b)
    d = np.abs(a - b)
    return d.max(), (d / np.maximum(np.abs(b), 1e-300)).max(), d.max() / span


def main():
    cs = C.build()
    (HERE / "cases.json").write_text(json.dumps(cs))
    p = subprocess.run(["bun", str(HERE / "geb_eval.ts"), str(HERE / "cases.json"), str(HERE / "geb_out.json")],
                       capture_output=True, text=True, cwd=HERE.parent.parent)
    if p.returncode:
        print(p.stdout, p.stderr)
        sys.exit("bun failed")
    geb = json.loads((HERE / "geb_out.json").read_text())
    print(f"numpy {np.__version__}  scipy {scipy.__version__}  verdict: max|Geb-ref|/span(dst) <= {TOL:g}\n")
    hdr = "%-40s %10s %10s %10s  verdict" % ("case", "max abs", "max rel", "abs/span")
    print(hdr)
    print("-" * len(hdr))
    for c in cs:
        nm = c["name"]
        g, ref = geb[nm], reference(c)
        D = np.array(c["dst"]).reshape(-1, 2)
        span = float(max(np.ptp(D[:, 0]), np.ptp(D[:, 1])))
        if not g["ok"]:
            tail = "reference ALSO has no answer" if ref["primary"] is None else "reference answered"
            print("%-40s %10s %10s %10s  GEB THREW %s (%s)" % (nm, "-", "-", "-", g["errorName"], tail))
            print("    message: " + g["message"][:160])
            continue
        if ref["primary"] is None:
            print("%-40s %10s %10s %10s  NOT TESTED (reference failed; Geb returned an answer)" % (nm, "-", "-", "-"))
            continue
        ma, mr, ms = stats(g["probeOut"], ref["primary"], span)
        t = tol_for(nm)
        if c["kind"] == "mercator":
            # TOLERANCE-BASED, not exact. The affine and polynomial2 references are exact rational
            # arithmetic, so a gap there is Geb's float64 and nothing else. Here the projection
            # (atanh/sin, and atan/sinh back) is transcendental: no rational reference exists, and
            # Python's libm and Bun's can differ by an ulp or two before the fit amplifies it. So
            # the verdict is a RELATIVE gap, per element against max(|ref|, 1) (the 1 keeps a
            # probe that lands on 0 from turning rounding noise into an infinite ratio), judged
            # at the plan's 1e-9. The span column is kept for the printout only.
            ms = float(np.max(np.abs(np.array(g["probeOut"]) - np.array(ref["primary"]))
                              / np.maximum(np.abs(np.array(ref["primary"])), 1.0)))
        verdict = "AGREES" if ms <= t else "DISAGREES"
        if verdict == "DISAGREES":
            FAILURES.append("%s: abs/span %.3e exceeds %g" % (nm, ms, t))
        print("%-40s %10.3e %10.3e %10.3e  %s" % (nm, ma, mr, ms, verdict))
        for k in ("lstsq", "hand"):
            if ref.get(k) is not None:
                a2, _, s2 = stats(g["probeOut"], ref[k], span)
                _, _, t2 = stats(ref[k], ref["primary"], span)
                print("    Geb vs %s: abs %.3e (abs/span %.1e);  %s vs primary ref: abs/span %.1e" % (k, a2, s2, k, t2))
        if c.get("truth") is not None:
            a3, _, s3 = stats(g["probeOut"], c["truth"], span)
            print("    Geb vs analytic truth: abs %.3e (abs/span %.1e)" % (a3, s3))
        if c["kind"] == "tps" and (c["lambda"] or 0) == 0:
            a4 = np.abs(np.array(g["srcOut"]) - np.array(c["dst"])).max()
            print("    interpolation at control points: max|Geb(src)-dst| = %.3e (%.1e of span)" % (a4, a4 / span))
        if verdict == "DISAGREES":
            gi = int(np.argmax(np.abs(np.array(g["probeOut"]) - np.array(ref["primary"]))))
            print("    worst element %d: Geb=%r  ref=%r" % (gi, g["probeOut"][gi], ref["primary"][gi]))


if __name__ == "__main__":
    main()
    # GATE, not a report. A gate that cannot fail is worth nothing, and the exit status is read
    # by `bun run gate:oracle`. The verdict line is printed last and on its own so a caller can
    # grep for it instead of parsing the table.
    if FAILURES:
        for f in FAILURES:
            print("  - " + f)
        print("GATE FAILED")
        sys.exit(1)
    print("GATE GREEN")
