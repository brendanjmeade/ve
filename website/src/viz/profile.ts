// The mid-strike profile: what was solved, against the layered reference.
//
// Two small charts, one per component, each with its own axis. The curves
// arrive as stacks of states, whole and in double precision, with the weights
// that take a stack to each quantity of time: a curve at a time is one row of
// weights times its stack. (The sheets cannot be shipped that way -- they are
// megabytes, and the weights sum to 200 -- but a profile is 45 points.)
//
// Colour is identity here and nothing else: the curve drawn in the scene is
// blue, what it is compared with orange, the reference ink. The legend says
// so in words, the pointer reads every curve at once, and text is never the
// colour of a series.

import { fmt, rowAt, type Curve, type Model, type Profile } from "./payload";

const NS = "http://www.w3.org/2000/svg";
const W = 380, H = 210, M = { l: 46, r: 12, t: 12, b: 34 };
const ROLE: Record<string, { color: string; width: number; dots: boolean }> = {
  model: { color: "#2a78d6", width: 2, dots: true },
  other: { color: "#eb6834", width: 2, dots: true },
  reference: { color: "#222222", width: 1.25, dots: false },
};
const ORDER = ["other", "model", "reference"];      // drawn back to front

function el<K extends keyof SVGElementTagNameMap>(
  tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** The next round number at or beyond `v`, so an axis ends on a value worth
 *  printing without leaving half of itself empty. */
function nice(v: number): number {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (m * p >= v * 0.999) return Number((m * p).toPrecision(2));
  }
  return 10 * p;
}

interface Chart {
  svg: SVGSVGElement;
  plot: SVGGElement;
  hair: SVGLineElement;
  ticks: SVGGElement;
  lo: number; hi: number;
}

export class ProfilePanel {
  private profile!: Profile;
  private charts: Chart[] = [];
  private span = 1;
  private legend: HTMLElement;
  private what: HTMLElement;
  private tip: HTMLElement;
  private readout: HTMLElement;
  private wrap: HTMLElement;
  private limits = new Map<string, [number, number][]>();
  private now: { key: string; values: Map<string, number[][]> } | null = null;

  constructor(private root: HTMLElement) {
    root.textContent = "";
    this.legend = document.createElement("div");
    this.legend.className = "legend";
    this.what = document.createElement("p");
    this.what.className = "what";
    this.wrap = document.createElement("div");
    this.wrap.className = "charts";
    this.tip = document.createElement("div");
    this.tip.className = "tip";
    this.tip.hidden = true;
    this.readout = document.createElement("p");
    this.readout.className = "misfit";
    root.append(this.what, this.legend, this.wrap, this.readout, this.tip);
  }

  setData(profile: Profile, _model: Model) {
    this.profile = profile;
    this.limits.clear();
    this.span = Math.max(...profile.curves.flatMap((c) => c.x.map(Math.abs)));
    this.legend.textContent = "";
    for (const key of ["model", "other", "reference"]) {
      const c = profile.curves.find((k) => k.key === key);
      if (!c) continue;
      const item = document.createElement("span");
      item.className = "item";
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.borderTopColor = ROLE[key].color;
      sw.style.borderTopWidth = `${Math.max(2, ROLE[key].width)}px`;
      const label = document.createElement("span");
      label.textContent = c.label;
      item.append(sw, label);
      this.legend.append(item);
    }
    this.wrap.textContent = "";
    this.charts = profile.components.map((name, comp) => this.build(name, comp));
  }

  private build(name: string, comp: number): Chart {
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
                            "aria-label": `${name} profile across the trench` });
    const frame = el("rect", { x: M.l, y: M.t, width: W - M.l - M.r,
                               height: H - M.t - M.b, fill: "none",
                               stroke: "#222", "stroke-width": 0.8 });
    const ticks = el("g", { class: "ticks" });
    const plot = el("g");
    const hair = el("line", { y1: M.t, y2: H - M.b, stroke: "#888",
                              "stroke-width": 0.8, visibility: "hidden" });
    const xl = el("text", { x: M.l + (W - M.l - M.r) / 2, y: H - 4,
                            "text-anchor": "middle", class: "lab" });
    xl.textContent = "x (km)";
    const yl = el("text", { x: 12, y: M.t + (H - M.t - M.b) / 2,
                            "text-anchor": "middle", class: "lab",
                            transform: `rotate(-90 12 ${M.t + (H - M.t - M.b) / 2})` });
    yl.textContent = name.split(",")[0];
    svg.append(ticks, plot, hair, frame, xl, yl);
    this.wrap.append(svg);
    const chart: Chart = { svg, plot, hair, ticks, lo: -1, hi: 1 };
    svg.addEventListener("pointermove", (e) => this.hover(e, chart, comp));
    svg.addEventListener("pointerleave", () => this.unhover());
    return chart;
  }

  private sx(x: number) { return M.l + (x + this.span) / (2 * this.span) * (W - M.l - M.r); }
  private sy(c: Chart, y: number) {
    return M.t + (c.hi - y) / (c.hi - c.lo) * (H - M.t - M.b);
  }

  /** A curve at one row of weights: `[point][component]`. */
  private at(curve: Curve, w: Float64Array): number[][] {
    const n = curve.x.length, out: number[][] = [];
    for (let i = 0; i < n; i++) out.push([0, 0]);
    for (let s = 0; s < w.length; s++) {
      const ws = w[s], row = curve.stack[s];
      if (ws === 0) continue;
      for (let i = 0; i < n; i++) {
        out[i][0] += ws * row[i][0];
        out[i][1] += ws * row[i][1];
      }
    }
    return out;
  }

  /** Axis limits of a quantity: fixed across its times, so the curves move
   *  and the axes do not. */
  private limit(key: string): [number, number][] {
    const hit = this.limits.get(key);
    if (hit) return hit;
    const rows = this.profile.weights[key];
    const out: [number, number][] = [[0, 0], [0, 0]];
    for (const r of rows) {
      const w = Float64Array.from(r);
      for (const c of this.profile.curves) {
        for (const p of this.at(c, w)) {
          for (const k of [0, 1]) {
            out[k][0] = Math.min(out[k][0], p[k]);
            out[k][1] = Math.max(out[k][1], p[k]);
          }
        }
      }
    }
    const lim = out.map(([lo, hi]) =>
      [lo < 0 ? -nice(-lo) : 0, hi > 0 ? nice(hi) : 0] as [number, number]);
    for (const l of lim) if (l[0] === l[1]) l[1] = l[0] + 1;
    this.limits.set(key, lim);
    return lim;
  }

  /** Draw row `pos` of quantity `key`; `what` says in words what that is. */
  set(key: string, pos: number, what: string) {
    if (!this.profile) return;
    this.what.textContent = what;
    const w = rowAt(this.profile.weights[key], pos);
    const lim = this.limit(key);
    const values = new Map<string, number[][]>();
    for (const c of this.profile.curves) values.set(c.key, this.at(c, w));
    this.now = { key, values };

    this.charts.forEach((chart, comp) => {
      [chart.lo, chart.hi] = lim[comp];
      this.axes(chart);
      chart.plot.textContent = "";
      if (chart.lo < 0 && chart.hi > 0) {
        chart.plot.append(el("line", {
          x1: M.l, x2: W - M.r, y1: this.sy(chart, 0), y2: this.sy(chart, 0),
          stroke: "#bbb", "stroke-width": 0.6 }));
      }
      for (const role of ORDER) {
        const c = this.profile.curves.find((k) => k.key === role);
        if (!c) continue;
        const v = values.get(role)!, st = ROLE[role];
        // never a line across the trench: the ground jumps there
        for (const side of [-1, 1]) {
          const pts: string[] = [];
          c.x.forEach((x, i) => {
            if (Math.sign(x) !== side) return;
            const X = this.sx(x), Y = this.sy(chart, v[i][comp]);
            pts.push(`${X.toFixed(1)},${Y.toFixed(1)}`);
            if (st.dots) {
              chart.plot.append(el("circle", { cx: X.toFixed(1), cy: Y.toFixed(1),
                                               r: 2, fill: st.color }));
            }
          });
          chart.plot.append(el("polyline", {
            points: pts.join(" "), fill: "none", stroke: st.color,
            "stroke-width": st.width, "stroke-linejoin": "round" }));
        }
      }
    });

    const parts: string[] = [];
    for (const c of this.profile.curves) {
      const m = this.profile.misfit[c.key]?.[key];
      if (!m) continue;
      const i = Math.min(Math.round(pos), m.length - 1);
      if (m[i] == null) continue;
      parts.push(`${c.label} ${(100 * (m[i] as number)).toFixed(1)} %`);
    }
    this.readout.textContent = parts.length
      ? `Difference from the reference, both components: ${parts.join("; ")}.`
      : "At the earthquake nothing has moved since it.";
  }

  private axes(c: Chart) {
    c.ticks.textContent = "";
    const add = (x: number, y: number, text: string, anchor: string, dy = 0) => {
      const t = el("text", { x, y: y + dy, "text-anchor": anchor, class: "tick" });
      t.textContent = text;
      c.ticks.append(t);
    };
    const s = Math.round(this.span);
    for (const x of [-s, 0, s]) {
      const X = this.sx(x);
      c.ticks.append(el("line", { x1: X, x2: X, y1: H - M.b, y2: H - M.b + 3,
                                  stroke: "#222", "stroke-width": 0.8 }));
      add(X, H - M.b + 14, fmt(x), "middle");
    }
    const ys = [c.lo, c.hi];
    if (c.lo < 0 && c.hi > 0) ys.splice(1, 0, 0);
    for (const y of ys) {
      const Y = this.sy(c, y);
      c.ticks.append(el("line", { x1: M.l - 3, x2: M.l, y1: Y, y2: Y,
                                  stroke: "#222", "stroke-width": 0.8 }));
      add(M.l - 5, Y, fmt(y), "end", 3.5);
    }
  }

  private hover(e: PointerEvent, chart: Chart, comp: number) {
    if (!this.now) return;
    const box = chart.svg.getBoundingClientRect();
    const px = (e.clientX - box.left) / box.width * W;
    const x = (px - M.l) / (W - M.l - M.r) * 2 * this.span - this.span;
    const model = this.profile.curves.find((c) => c.key === "model")!;
    let best = 0;
    model.x.forEach((v, i) => {
      if (Math.abs(v - x) < Math.abs(model.x[best] - x)) best = i;
    });
    const at = model.x[best];
    for (const c of this.charts) {
      c.hair.setAttribute("x1", String(this.sx(at)));
      c.hair.setAttribute("x2", String(this.sx(at)));
      c.hair.setAttribute("visibility", "visible");
    }
    this.tip.textContent = "";
    const head = document.createElement("div");
    head.className = "head";
    head.textContent = `x = ${fmt(at)} km, ${this.profile.components[comp].split(",")[0]}`;
    this.tip.append(head);
    for (const key of ["model", "other", "reference"]) {
      const c = this.profile.curves.find((k) => k.key === key);
      if (!c) continue;
      let j = 0;
      c.x.forEach((v, i) => { if (Math.abs(v - at) < Math.abs(c.x[j] - at)) j = i; });
      const row = document.createElement("div");
      row.className = "row";
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.borderTopColor = ROLE[key].color;
      const val = document.createElement("b");
      val.textContent = fmt(this.now.values.get(key)![j][comp]);
      const lab = document.createElement("span");
      lab.textContent = c.label;
      row.append(sw, val, lab);
      this.tip.append(row);
    }
    const host = this.root.getBoundingClientRect();
    this.tip.hidden = false;
    const left = Math.min(e.clientX - host.left + 14, host.width - 230);
    this.tip.style.left = `${Math.max(0, left)}px`;
    this.tip.style.top = `${e.clientY - host.top + 14}px`;
  }

  private unhover() {
    this.tip.hidden = true;
    for (const c of this.charts) c.hair.setAttribute("visibility", "hidden");
  }
}
