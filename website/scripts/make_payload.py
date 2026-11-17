"""Build ``website/public/data`` from stored mbem runs.

    python website/scripts/make_payload.py --runs ~/desktop/mbem/runs

Nothing is solved here. A stored run holds one boundary solution per Laplace
state; this reads them back, and writes each model as

* sheets -- triangle meshes with values at their nodes (the free surface, the
  interface, a creeping fault, a section through the volume), every field on
  them as float32 MODES plus one small table per quantity of time; and
* a profile -- the mid-strike line against the layered reference, small
  enough to ship whole, with the weights that take it to time.

Every number that could be wrong quietly is made by ``mbem.webexport``, which
mbem's gates check (``verify_volume`` [i]): the modes, the tables, the
node averaging that must not cross a fault. This file only names the studies
and writes the schema ``src/viz/payload.ts`` reads.

A STEPPED run (``mbem.stepper``: a fault under a law that is not linear) has
no Laplace state to weigh: it is already a history, every boundary unknown at
every time. It goes out in the same form -- modes, and a table whose rows
are the times themselves -- so the page draws it with the code it draws the
others with. It has no velocity, no cycle and no section through the volume:
none of those exists for a stepped run.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib

import numpy as np

from mbem import TriMesh, figures as F, laplace, webexport as W
from mbem.cases import layered_box as lb
from mbem.figures import plate as P

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent / "public" / "data"
SCHEMA = 1

# One entry per model the site shows: the study it is read from (the run id's
# last field), the run drawn, and what its profile is compared with.
MODELS = (
    {"key": "megathrust", "label": "megathrust", "study": "491d",
     "run": {"refine": 2.0},
     "curves": (("model", "finest mesh, as solved", {"refine": 2.0}, None),
                ("other", "two-mesh limit", {"refine": 2.0}, {"refine": 1.0})),
     "reference": ("layered reference", {"refine": 2.0}),
     "blurb": "A thrust dipping 20 degrees from the surface to 45 km, through "
              "a 30 km elastic plate into the Maxwell substrate below it. The "
              "rupture is 300 km long and slips uniformly."},
    {"key": "afterslip", "label": "megathrust, lower reach creeping",
     "study": "0f06", "run": {"creep_tau": 1.0, "refine": 1.5},
     "curves": (("model", "lower reach creeping", {"creep_tau": 1.0, "refine": 1.5}, None),
                ("other", "lower reach held", {"creep_tau": 1000000.0, "refine": 1.5}, None)),
     "reference": ("layered reference, no afterslip", {"creep_tau": 1.0, "refine": 1.5}),
     "blurb": "The same thrust, 200 km long, slipping in the plate only. Its "
              "lower reach, from 30 to 45 km, is a fault that resists its "
              "slip rate: it is locked in the earthquake and slips afterwards."},
    {"key": "slab", "label": "megathrust on a subducting slab", "study": "6caa",
     "run": {"slab_depth": 150.0},
     "curves": (("model", "slab to 150 km", {"slab_depth": 150.0}, None),
                ("other", "no slab", {"slab_depth": 0.0}, None)),
     "reference": ("layered reference, no slab", {"slab_depth": 0.0}),
     "blurb": "A thrust through the 30 km plate, 200 km long, with the "
              "footwall plate continued down dip to 150 km as an elastic slab "
              "in the relaxing mantle."},
    {"key": "burgers", "label": "megathrust, Burgers substrate",
     "study": "e351", "run": {"tau_K": 0.1},
     "curves": (("model", "Burgers substrate", {"tau_K": 0.1}, None),
                ("other", "Maxwell substrate", {"tau_K": 0.0}, None)),
     "reference": ("layered reference, Burgers", {"tau_K": 0.1}),
     "blurb": "The first model again, on a substrate that relaxes twice: a "
              "Burgers material, whose transient element gives up half its "
              "shear modulus within a tenth of a Maxwell time before the "
              "steady flow takes the rest."},
    {"key": "slab_afterslip",
     "label": "slab, Burgers mantle, afterslip on the slab's face",
     "study": "05b1", "run": {"creep_tau": 1.0},
     "curves": (("model", "slab's face creeping", {"creep_tau": 1.0}, None),
                ("other", "slab's face held", {"creep_tau": 1000000.0}, None)),
     "reference": ("layered reference: no slab, no afterslip",
                   {"creep_tau": 1.0}),
     "blurb": "The three together. A thrust ruptures the 30 km plate, 200 km "
              "long; the footwall plate goes on down dip to 150 km as an "
              "elastic slab; the mantle around it is a Burgers material; and "
              "below the plate, from 30 to 50 km, the megathrust runs down "
              "the slab's upper face, where slab and mantle wedge slide past "
              "each other at a rate proportional to the shear traction "
              "between them. Locked in the earthquake, it slips afterwards."},
    {"key": "slab_friction",
     "label": "the same, the slab's face under friction",
     "stepped": "d2f7", "linear": ("05b1", {"creep_tau": 1.0}),
     "blurb": "The same model after an earthquake of 5 m, with a law that is "
              "not linear on the slab's face: friction that strengthens with "
              "slip rate, at steady state, with a sigma = 1 MPa. Such a law "
              "has no Laplace state, so the face is stepped through time "
              "instead, the rest of the body reduced to what the face feels. "
              "It is the linear law of the model above for a small change "
              "of traction and faster above it, so it knows how large the "
              "earthquake was."},
)

QUANTITY = {
    "since": ("displacement since the earthquake", "of the slip"),
    "total": ("displacement, earthquake included", "of the slip"),
    "rate": ("velocity", "slip per Maxwell time"),
    "locked": ("velocity of the locked fault", "of the slip rate"),
}
SHEET = {"top": "free surface", "interface": "base of the plate",
         "fault_lower": "creeping reach", "section": "section at mid-strike"}
# A stress is GPa for the run's slip in km: over the slip it is GPa/km, which
# is MPa per metre.
STRESS_UNIT = {"since": "MPa per metre of slip",
               "total": "MPa per metre of slip",
               "rate": "MPa per metre of slip, per Maxwell time",
               "locked": "MPa per metre of plate motion"}
VIEW_DEPTH = 180.0          # km of the box drawn, and of a section shipped
SYM6 = ("xx", "yy", "zz", "xy", "yz", "xz")


def num(a, digits=None):
    """A JSON-ready nested list. ``digits`` rounds for the things a viewer
    only draws; ``None`` keeps every bit, for what it multiplies."""
    a = np.asarray(a, float)
    if digits is not None:
        with np.errstate(invalid="ignore", divide="ignore"):
            mag = np.where(a == 0, 1.0, 10.0 ** np.floor(np.log10(np.abs(a))))
        a = np.round(a / mag, digits - 1) * mag
    return json.loads(json.dumps(np.where(np.isfinite(a), a, np.nan).tolist())
                      .replace("NaN", "null"))


class Out:
    """The data directory: arrays written by name, with their size and hash."""

    def __init__(self, root: pathlib.Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self.wrote: set = set()

    def array(self, name: str, a: np.ndarray) -> dict:
        buf = np.ascontiguousarray(a).astype(a.dtype.newbyteorder("<")).tobytes()
        (self.root / f"{name}.bin").write_bytes(buf)
        self.wrote.add(f"{name}.bin")
        return {"file": f"{name}.bin", "bytes": len(buf),
                "sha256": hashlib.sha256(buf).hexdigest()[:16]}

    def json(self, name: str, obj) -> str:
        (self.root / name).write_text(json.dumps(obj, separators=(",", ":"))
                                      + "\n")
        self.wrote.add(name)
        return name

    def prune(self) -> list:
        stale = [p for p in self.root.iterdir()
                 if p.is_file() and p.name not in self.wrote]
        for p in stale:
            p.unlink()
        return sorted(p.name for p in stale)


def quantities(s, periods) -> dict:
    out = {}
    for name, q in W.time_weights(s, periods).items():
        label, unit = QUANTITY[name.split(":")[0]]
        out[name] = {"axis": q["axis"], "at": num(q["at"], 6), "label": label,
                     "unit": unit, **({"period": q["period"]}
                                      if "period" in q else {})}
    return out


def limits(field: np.ndarray) -> dict:
    """Colour limits of one quantity, fixed across its times: for each
    scalar a viewer can draw, the value 99.5 % of the nodes stay under at
    every time."""
    def hi(a):
        return float(np.percentile(np.abs(a).max(axis=0), 99.5))

    c = field.shape[-1]
    if c == 1:
        return {"value": hi(field[..., 0])}
    if c == 6:
        # von Mises of the tensor at each time, never a difference of two
        xx, yy, zz, xy, yz, xz = np.moveaxis(field, -1, 0)
        vm = np.sqrt(0.5 * ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2)
                     + 3.0 * (xy ** 2 + yz ** 2 + xz ** 2))
        peak = vm.max(axis=0)
        return {"von_mises": float(np.percentile(peak, 99.5)),
                "von_mises_lo": float(np.percentile(peak, 2.0))}
    mag = np.linalg.norm(field, axis=-1)
    return {"x": hi(field[..., 0]), "y": hi(field[..., 1]),
            "z": hi(field[..., 2]), "mag": hi(mag)}


def encode(out: Out, name: str, stack: np.ndarray, s, periods,
           unit: dict = None) -> dict:
    """One field of one sheet: modes to a file, a table per quantity, and
    how far the decode is from the map it stands for."""
    modes, C = W.encode_modes(stack)
    entry = {"components": int(stack.shape[-1]), "modes": int(modes.shape[0]),
             **out.array(name, modes), "rows": {}, "range": {}, "error": {}}
    if unit:
        entry["unit"] = {q: unit[q.split(":")[0]]
                         for q in W.time_weights(s, periods)}
    weights = W.time_weights(s, periods)
    for q, tb in W.time_tables(s, C, periods).items():
        got = W.decode_modes(modes, tb["rows"])
        want = np.tensordot(weights[q]["w"], stack, axes=1)
        entry["rows"][q] = num(tb["rows"])
        entry["range"][q] = {k: float(f"{v:.4g}")
                             for k, v in limits(got).items()}
        entry["error"][q] = float(f"{np.abs(got - want).max() / np.abs(want).max():.2g}")
    return entry


# ---- a stepped run: a history, in the same form --------------------------

def history_quantities(t) -> dict:
    return {q: {"axis": "time", "at": num(t, 6), "label": QUANTITY[q][0],
                "unit": QUANTITY[q][1]} for q in ("since", "total")}


def encode_history(out: Out, name: str, field: np.ndarray) -> dict:
    """One field of one sheet of a stepped run, ``(n_times, n_nodes, c)``
    with the earthquake first: modes, and the two tables a history has --
    each time as it is, and each time less the earthquake."""
    modes, C = W.encode_modes(field)
    entry = {"components": int(field.shape[-1]), "modes": int(modes.shape[0]),
             **out.array(name, modes), "rows": {}, "range": {}, "error": {}}
    for q, rows, want in (("since", C - C[0], field - field[0]),
                          ("total", C, field)):
        got = W.decode_modes(modes, rows)
        entry["rows"][q] = num(rows)
        entry["range"][q] = {k: float(f"{v:.4g}")
                             for k, v in limits(got).items()}
        entry["error"][q] = float(
            f"{np.abs(got - want).max() / np.abs(want).max():.2g}")
    return entry


def stepped(out: Out, spec: dict, runs: pathlib.Path) -> dict:
    """A model stepped in time, beside the linear run it is compared with."""
    hits = sorted(runs.glob(f"*-{spec['stepped']}"))
    if len(hits) != 1:
        raise FileNotFoundError(f"{spec['key']}: {len(hits)} runs end in "
                                f"-{spec['stepped']} under {runs}")
    run = F.load_run(hits[0])
    key, res, hist = spec["key"], run.resolved, run.history
    t = hist["t"]
    if t[0] != 0.0:
        raise ValueError(f"{key}: a stepped run is shipped from the "
                         f"earthquake on; its first time is {t[0]:g}")
    gp, mp = (res["spec"]["model"]["geometry"]["params"],
              res["spec"]["model"]["params"])
    slip = mp.get("slip_mag", 1.0e-3)
    faults = [TriMesh(run.meshes[f"{n}__v"], run.meshes[f"{n}__t"])
              for n in ("fault", "fault_lower")]
    sense = lb.burgers(1.0, mp.get("rake", 180.0), run.meshes["arr__n_hat"],
                       run.meshes["arr__s_hat"])

    def one(name, field, split, what):
        v, tr = run.meshes[f"{name}__v"], run.meshes[f"{name}__t"]
        nodes, tri, A = W.node_sheet(v, tr, split)
        at = np.stack([A @ f for f in field]) / slip
        return {"label": SHEET[name], "nodes": int(nodes.shape[0]),
                "triangles": int(tri.shape[0]), "elements": int(tr.shape[0]),
                "mesh": {"nodes": out.array(f"{key}.{name}.nodes",
                                            nodes.astype(np.float32)),
                         "triangles": out.array(f"{key}.{name}.tris",
                                                tri.astype(np.uint32))},
                "fields": {what: encode_history(out, f"{key}.{name}.{what}",
                                                at)}}

    sheets = {n: one(n, hist[f"u:{n}"], faults, "u")
              for n in ("top", "interface")}
    sheets["fault_lower"] = one(
        "fault_lower", (hist["b:fault_lower"] @ sense)[..., None], (), "slip")

    # the profile: this run, the linear law's run at the same times, and the
    # layered reference, each a stack over TIMES; the weights are then the
    # identity, and the identity less the earthquake
    study = F.load_study(_one(runs, spec["linear"][0], key))
    lin = study.one(**spec["linear"][1])
    s, x_lin, u_lin = P.in_plane(lin)
    w = W.time_weights(s)["total"]
    if not np.allclose(w["at"], t, rtol=1e-9, atol=0.0):
        raise ValueError(f"{key}: the stepped run's times are not the "
                         f"linear run's")
    _t, x, u = P.in_plane_stepped(run)
    if not np.allclose(x, x_lin):
        raise ValueError(f"{key}: the two runs' profiles are not at the "
                         f"same points")
    span = float(np.abs(x).max())
    xf = np.linspace(-span, span, 161)
    xf = xf[np.abs(xf) > 0.5]
    curves = [
        {"key": "model", "label": f"friction, {slip * 1e3:g} m of slip",
         "x": num(x, 6), "stack": num(u)},
        {"key": "other", "label": "the linear law", "x": num(x, 6),
         "stack": num(np.tensordot(w["w"], u_lin, axes=1))},
        {"key": "reference", "label": "layered reference: no slab, no "
         "afterslip", "x": num(xf, 6),
         "stack": num(np.tensordot(w["w"], P.in_plane_reference(lin, s, xf),
                                   axes=1))}]
    eye = np.eye(t.size)
    since = eye.copy()
    since[:, 0] -= 1.0
    weights = {"since": since, "total": eye}
    ref = np.tensordot(w["w"], P.in_plane_reference(lin, s, x), axes=1)
    misfit = {}
    for c in curves[:2]:
        got = np.array(c["stack"])
        misfit[c["key"]] = {}
        for q, wq in weights.items():
            a, b = (np.tensordot(wq, k, axes=1) for k in (got, ref))
            with np.errstate(invalid="ignore", divide="ignore"):
                m = np.sqrt(((a - b) ** 2).sum(axis=(1, 2))
                            / (b ** 2).sum(axis=(1, 2)))
            misfit[c["key"]][q] = num(m, 3)
    profile_file = out.json(f"{key}.profile.json", {
        "components": ["horizontal, across the trench", "vertical"],
        "curves": curves, "misfit": misfit, "s": num(t),
        "weights": {q: num(wq) for q, wq in weights.items()}})

    outlines = {n: num(W.boundary_segments(run.meshes[f"{n}__v"],
                                           run.meshes[f"{n}__t"]), 6)
                for n in ("fault", "fault_lower")}
    lo = np.min([run.meshes[k].min(axis=0) for k in run.meshes
                 if k.endswith("__v")], axis=0)
    hi = np.max([run.meshes[k].max(axis=0) for k in run.meshes
                 if k.endswith("__v")], axis=0)
    rep = run.report
    t0, t1 = laplace.window(s)
    entry = {
        "schema": SCHEMA, "key": key, "label": spec["label"],
        "blurb": spec["blurb"],
        "source": {"run": run.run_dir.name,
                   "mbem_git": res.get("env", {}).get("git"),
                   "command": "python -m mbem run configs/plate_substrate.py"},
        "numbers": {
            "unknowns": res["model"]["n_unknowns"],
            "elements": res["model"]["n_tris"],
            "states": len(res["states"]),
            "backend": res["spec"]["backend"]["kind"],
            "wall_s": round(rep.get("wall_s", 0.0)),
            "dip": gp["dip"], "rake": mp.get("rake"),
            "fault_depth": gp["fault_depth"],
            "fault_half_len": gp["fault_half_len"],
            "plate": -gp["z_interface"], "half_x": gp["half_x"],
            "depth": -gp["z_bottom"], "slab_depth": gp.get("slab_depth", 0.0),
            "sides": mp.get("sides"), "lower": mp.get("lower", "slip"),
            "density": (res["model"].get("gravity") or {}).get("density"),
            "rheology": res["spec"]["laplace"]["rheology"],
            "creep": res["spec"]["stepper"]["faults"],
            "slip_m": slip * 1.0e3,
            "stepped": {"slip_unknowns": rep["stepper"]["slip_unknowns"],
                        "law_evaluations": rep["stepper"]["law_evaluations"],
                        "march_s": round(rep["phases"]["march"])}},
        "box": {"lo": num(lo, 6), "hi": num(hi, 6)},
        "window": [float(f"{t0:.6g}"), float(f"{t1:.6g}")],
        "view_depth": VIEW_DEPTH,
        "quantities": history_quantities(t),
        "sheets": sheets, "outlines": outlines, "creeping": True,
        "profile": profile_file}
    out.json(f"{key}.json", entry)
    return {"key": key, "label": spec["label"], "file": f"{key}.json"}


def _one(runs: pathlib.Path, tail: str, key: str) -> pathlib.Path:
    hits = sorted(runs.glob(f"*-{tail}"))
    if len(hits) != 1:
        raise FileNotFoundError(f"{key}: {len(hits)} studies end in -{tail} "
                                f"under {runs}")
    return hits[0]


def sheet(out: Out, key: str, name: str, run, s, stack, faults, periods,
          slip: float) -> dict:
    v, t = run.meshes[f"{name}__v"], run.meshes[f"{name}__t"]
    nodes, tri, A = W.node_sheet(v, t, faults)
    entry = {"label": SHEET[name], "nodes": int(nodes.shape[0]),
             "triangles": int(tri.shape[0]), "elements": int(t.shape[0]),
             "mesh": {"nodes": out.array(f"{key}.{name}.nodes",
                                         nodes.astype(np.float32)),
                      "triangles": out.array(f"{key}.{name}.tris",
                                             tri.astype(np.uint32))},
             "fields": {}}
    if name == "fault_lower":
        _s, _cen, _area, creep = P.creep_on(run)          # (n_states, n_elem)
        at = np.stack([A @ c for c in creep])[..., None]
        entry["fields"]["slip"] = encode(out, f"{key}.{name}.slip", at, s,
                                         periods)
    else:
        at = np.stack([A @ u for u in stack[f"u:{name}"]]) / slip
        entry["fields"]["u"] = encode(out, f"{key}.{name}.u", at, s, periods)
    return entry


def section(out: Out, key: str, run, s, vol: pathlib.Path, periods,
            slip: float) -> dict:
    """A vertical section at mid-strike, from ``mbem sample --section y=0``:
    the displacement and the elastic stress of every state at the points of
    a lattice, which is its own mesh. Nothing is averaged here; the points
    are where the fields were evaluated."""
    from mbem import config as cfg, vti

    sampled = json.loads((vol / "resolved.json").read_text())
    grid = sampled["grid"]
    # how the points were read: close to a boundary from a continuous
    # displacement ("near", mbem's recover.NearField) or from the elements'
    # values ("plain"), and by which commit of mbem
    readout = json.loads((vol / "report.json").read_text()).get("readout",
                                                                "plain")
    nx, ny, nz = grid["dims"]
    if ny != 1:
        raise ValueError(f"{vol.name} is not a section across y: dims "
                         f"{grid['dims']}")
    rows = sorted((r for r in run.resolved["states"] if r.get("s") is not None),
                  key=lambda r: -float(r["s"]))
    u, sig = [], []
    for r in rows:                                # the order Prony takes
        a = vti.read(vol / f"volume_{cfg.slug(r['label'])}.vti")["arrays"]
        u.append(np.asarray(a["u"], float).reshape(-1, 3))
        sig.append(np.stack([np.asarray(a[f"sigma_{c}"], float).ravel()
                             for c in SYM6], axis=-1))
    inside = np.asarray(a["region"], float).ravel() > 0
    x = grid["origin"][0] + grid["spacing"][0] * np.arange(nx)
    z = grid["origin"][2] + grid["spacing"][2] * np.arange(nz)
    Z, X = np.meshgrid(z, x, indexing="ij")
    keep = (inside & (Z.ravel() >= -VIEW_DEPTH)
            & np.isfinite(np.stack(u)).all(axis=(0, 2)))
    index = np.full(nx * nz, -1)
    index[keep] = np.arange(int(keep.sum()))
    at = np.arange(nx * nz).reshape(nz, nx)
    a, b, c, d = at[:-1, :-1], at[:-1, 1:], at[1:, 1:], at[1:, :-1]
    quads = np.stack([a, b, c, d], axis=-1).reshape(-1, 4)
    quads = quads[keep[quads].all(axis=1)]
    tri = index[np.concatenate([quads[:, [0, 1, 2]], quads[:, [0, 2, 3]]])]
    nodes = np.column_stack([X.ravel(), np.full(nx * nz, grid["origin"][1]),
                             Z.ravel()])[keep]
    return {
        "label": SHEET["section"], "nodes": int(nodes.shape[0]),
        "triangles": int(tri.shape[0]), "elements": int(tri.shape[0]),
        "spacing": grid["spacing"][0], "sampled": vol.name,
        "readout": readout, "mbem_git": sampled.get("env", {}).get("git"),
        "mesh": {"nodes": out.array(f"{key}.section.nodes",
                                    nodes.astype(np.float32)),
                 "triangles": out.array(f"{key}.section.tris",
                                        tri.astype(np.uint32))},
        "fields": {
            "u": encode(out, f"{key}.section.u",
                        np.stack(u)[:, keep] / slip, s, periods),
            "sigma": encode(out, f"{key}.section.sigma",
                            np.stack(sig)[:, keep] / slip, s, periods,
                            STRESS_UNIT)}}


def profile(out: Out, spec: dict, study, s, periods) -> str:
    """The mid-strike profile: each curve's stack of states, whole, and the
    weights that take a stack to each quantity of time."""
    curves, at_model = [], None
    for key, label, pick, coarse in spec["curves"]:
        run = study.one(**pick)
        sk, x, u = P.in_plane(run, study.one(**coarse) if coarse else None)
        if not np.allclose(sk, s):
            raise ValueError(f"{spec['key']}: the curves' states differ")
        curves.append({"key": key, "label": label, "x": num(x, 6),
                       "stack": num(u)})
        at_model = x if key == "model" else at_model
    label, pick = spec["reference"]
    ref_run = study.one(**pick)
    span = float(np.abs(at_model).max())
    xf = np.linspace(-span, span, 161)
    xf = xf[np.abs(xf) > 0.5]
    curves.append({"key": "reference", "label": label, "x": num(xf, 6),
                   "stack": num(P.in_plane_reference(ref_run, s, xf))})
    weights = W.time_weights(s, periods)
    # how far each solved curve is from the reference, at its own points
    misfit = {}
    for c in curves[:-1]:
        x = np.array(c["x"])
        ref = P.in_plane_reference(ref_run, s, x)
        got = np.array(c["stack"])
        misfit[c["key"]] = {}
        for q, tb in weights.items():
            a, b = (np.tensordot(tb["w"], k, axes=1) for k in (got, ref))
            with np.errstate(invalid="ignore", divide="ignore"):
                m = np.sqrt(((a - b) ** 2).sum(axis=(1, 2))
                            / (b ** 2).sum(axis=(1, 2)))
            misfit[c["key"]][q] = num(m, 3)
    # `s` names the columns of the weights: the elastic state, then these
    return out.json(f"{spec['key']}.profile.json", {
        "components": ["horizontal, across the trench", "vertical"],
        "curves": curves, "misfit": misfit, "s": num(s),
        "weights": {q: num(tb["w"]) for q, tb in weights.items()}})


def model(out: Out, spec: dict, runs: pathlib.Path) -> dict:
    hits = sorted(runs.glob(f"*-{spec['study']}"))
    if len(hits) != 1:
        raise FileNotFoundError(f"{spec['key']}: {len(hits)} studies end in "
                                f"-{spec['study']} under {runs}")
    study = F.load_study(hits[0])
    run = study.one(**spec["run"])
    key = spec["key"]
    s, stack = laplace.run_stack(run.run_dir)
    t0, t1 = laplace.window(s)
    longest = float(f"{t1 / P.CYCLES:.3g}")
    periods = (longest / 4.0, longest / 2.0, longest)
    res = run.resolved
    gp, mp = (res["spec"]["model"]["geometry"]["params"],
              res["spec"]["model"]["params"])
    slip = mp.get("slip_mag", 1.0e-3)
    faults = [TriMesh(run.meshes[f"{n}__v"], run.meshes[f"{n}__t"])
              for n in ("fault", "fault_lower") if f"{n}__t" in run.meshes]

    sheets = {n: sheet(out, key, n, run, s, stack, faults, periods, slip)
              for n in ("top", "interface")}
    creeping = "b:fault_lower" in stack
    if creeping:
        sheets["fault_lower"] = sheet(out, key, "fault_lower", run, s, stack,
                                      (), periods, slip)
    vol = runs / f"section-{key}"
    if (vol / "STATUS").exists() and (vol / "STATUS").read_text().strip() == "OK":
        sheets["section"] = section(out, key, run, s, vol, periods, slip)
    else:
        print(f"  no section: {vol.name} is not a finished `mbem sample "
              f"--section y=0 --out runs/{vol.name}`")
    outlines = {n: num(W.boundary_segments(run.meshes[f"{n}__v"],
                                           run.meshes[f"{n}__t"]), 6)
                for n in ("fault", "fault_lower") if f"{n}__t" in run.meshes}
    lo = np.min([run.meshes[k].min(axis=0) for k in run.meshes
                 if k.endswith("__v")], axis=0)
    hi = np.max([run.meshes[k].max(axis=0) for k in run.meshes
                 if k.endswith("__v")], axis=0)
    rep = run.report
    entry = {
        "schema": SCHEMA, "key": key, "label": spec["label"],
        "blurb": spec["blurb"],
        "source": {"study": hits[0].name, "run": run.run_dir.name,
                   "mbem_git": res.get("env", {}).get("git"),
                   "command": "python -m mbem run configs/plate_substrate.py"},
        "numbers": {
            "unknowns": res["model"]["n_unknowns"],
            "elements": res["model"]["n_tris"],
            "states": 1 + len(s), "backend": res["spec"]["backend"]["kind"],
            "wall_s": round(rep.get("wall_s", 0.0)),
            "dip": gp["dip"], "rake": mp.get("rake"),
            "fault_depth": gp["fault_depth"],
            "fault_half_len": gp["fault_half_len"],
            "plate": -gp["z_interface"], "half_x": gp["half_x"],
            "depth": -gp["z_bottom"], "slab_depth": gp.get("slab_depth", 0.0),
            "sides": mp.get("sides"), "lower": mp.get("lower", "slip"),
            "density": (res["model"].get("gravity") or {}).get("density"),
            "rheology": res["spec"]["laplace"]["rheology"],
            "creep": res["spec"]["laplace"].get("faults") or None},
        "box": {"lo": num(lo, 6), "hi": num(hi, 6)},
        "window": [float(f"{t0:.6g}"), float(f"{t1:.6g}")],
        "view_depth": VIEW_DEPTH,
        "quantities": quantities(s, periods),
        "sheets": sheets, "outlines": outlines, "creeping": creeping,
        "profile": profile(out, spec, study, s, periods)}
    out.json(f"{key}.json", entry)
    return {"key": key, "label": spec["label"], "file": f"{key}.json"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--runs", required=True, type=pathlib.Path,
                    help="mbem's runs/ directory")
    ap.add_argument("--out", type=pathlib.Path, default=OUT)
    ap.add_argument("--only", default=None,
                    help="comma-separated model keys; the others are kept "
                         "as they are on disk")
    a = ap.parse_args()
    out = Out(a.out)
    only = set(a.only.split(",")) if a.only else None
    index = []
    for spec in MODELS:
        if only and spec["key"] not in only:
            old = a.out / f"{spec['key']}.json"
            if old.exists():
                index.append({"key": spec["key"], "label": spec["label"],
                              "file": old.name})
                out.wrote |= {p.name for p in a.out.glob(f"{spec['key']}.*")}
            continue
        print(f"{spec['key']} ...", flush=True)
        index.append((stepped if "stepped" in spec else model)(
            out, spec, a.runs.expanduser()))
        entry = json.loads((a.out / f"{spec['key']}.json").read_text())
        for name, sh in entry["sheets"].items():
            for f, e in sh["fields"].items():
                print(f"  {name:12s} {f:5s} {sh['nodes']:6d} nodes, "
                      f"{e['modes']:2d} modes, {e['bytes'] / 1e6:5.2f} MB, "
                      f"decode error {max(e['error'].values()):.1e}")
    out.json("manifest.json", {"schema": SCHEMA, "models": index})
    stale = out.prune()
    total = sum(p.stat().st_size for p in a.out.iterdir())
    print(f"{len(index)} models, {total / 1e6:.1f} MB in {a.out}"
          + (f"; pruned {stale}" if stale else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
