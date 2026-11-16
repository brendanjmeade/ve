// The weights of a time: the figure on the Theory page.
//
// A displacement at time t is fourteen weights times the fourteen elastic
// solutions. This draws those weights, one bar per Laplace state, at the time
// on a slider. The weights are the payload's own (`mbem.webexport.
// time_weights`, in double precision, the same rows the profile is drawn
// with); nothing about the inversion is computed here.
//
// One series, so one colour and no legend: a bar's direction is its sign and
// its place is its state. Text is ink.

import { axisAt, fmt, Payload, rowAt, type Quantity } from "./payload";
import { Clock, posOf, Timeline } from "./timeline";

const NS = "http://www.w3.org/2000/svg";
const W = 760, H = 270, M = { l: 44, r: 14, t: 22, b: 48 };
const BLUE = "#2a78d6";

function el<K extends keyof SVGElementTagNameMap>(
  tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** A bar from the baseline `y0` to `y1`, its far end rounded. */
function bar(x: number, w: number, y0: number, y1: number): string {
  const r = Math.min(3, Math.abs(y1 - y0), w / 2) * Math.sign(y0 - y1);
  return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + Math.abs(r)},${y1}` +
         `H${x + w - Math.abs(r)}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
}

export async function startWeights(root: HTMLElement, baseUrl: string) {
  const q = <T extends Element>(s: string) => root.querySelector<T>(s)!;
  const note = q<HTMLElement>("[data-note]");
  const payload = new Payload(baseUrl);
  const clock = new Clock(16, 1.5);
  const timeline = new Timeline(q<HTMLElement>("[data-timeline]"), clock);
  timeline.say("loading…");

  let table: number[][], s: number[], axis: Quantity;
  try {
    await payload.load();
    const m = await payload.model(payload.manifest.models[0].key);
    const p = await payload.profile(m);
    table = p.weights.total;
    s = p.s;
    axis = m.quantities.total;
    if (!table || !s || table[0].length !== s.length + 1) throw new Error("no weights");
  } catch {
    timeline.say("The weights are not available in this build.");
    return;
  }

  const n = s.length + 1;                       // the elastic state, then s
  const top = Math.max(...table.flat().map(Math.abs));
  const lim = Math.ceil(top / 10) * 10;
  const most = Math.max(...table.map((r) => r.reduce((a, v) => a + Math.abs(v), 0)));
  const pw = W - M.l - M.r, ph = H - M.t - M.b;
  const band = pw / n, bw = Math.round(band * 0.5);
  const y = (v: number) => M.t + ph / 2 - (v / lim) * (ph / 2);
  const xc = (i: number) => M.l + (i + 0.5) * band;

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  svg.setAttribute("aria-label",
    "The fourteen weights that make the displacement at one time, one bar per Laplace state");
  const g = el("g");
  svg.append(g);
  // axes: a full frame, ticks only where they say something
  for (const v of [-lim, 0, lim]) {
    const t = el("text", { x: M.l - 6, y: y(v) + 4, "text-anchor": "end", class: "tick" });
    t.textContent = fmt(v);
    svg.append(t);
  }
  svg.append(el("line", { x1: M.l, x2: W - M.r, y1: y(0), y2: y(0),
                          stroke: "#888", "stroke-width": 0.6 }));
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    const time = i === 0 ? 0 : 1 / s[i - 1];
    names.push(i === 0 ? "the elastic state"
      : `the state at s = ${fmt(s[i - 1])} per τ (1/s = ${fmt(time)} τ)`);
    if (i === 0 || (i - 1) % 3 === 0) {
      const t = el("text", { x: xc(i), y: H - M.b + 15, "text-anchor": "middle", class: "tick" });
      t.textContent = i === 0 ? "elastic" : String(Number(time.toPrecision(2)));
      svg.append(t);
    }
  }
  const xl = el("text", { x: M.l + pw / 2, y: H - 8, "text-anchor": "middle", class: "lab" });
  xl.textContent = "Laplace state, by its time 1/s (Maxwell times)";
  const yl = el("text", { x: 12, y: M.t + ph / 2, "text-anchor": "middle", class: "lab",
                          transform: `rotate(-90 12 ${M.t + ph / 2})` });
  yl.textContent = "weight";
  const bars: SVGPathElement[] = [];
  for (let i = 0; i < n; i++) {
    const b = el("path", { fill: BLUE });
    bars.push(b);
    g.append(b);
  }
  // where the clock is, on the same axis: the state whose 1/s is the time
  const hand = el("line", { y1: M.t, y2: H - M.b, stroke: "#222", "stroke-width": 0.9 });
  const handLabel = el("text", { y: M.t - 7, "text-anchor": "middle", class: "lab" });
  handLabel.textContent = "t";
  const frame = el("rect", { x: M.l, y: M.t, width: pw, height: ph, fill: "none",
                             stroke: "#222", "stroke-width": 0.8 });
  // a hit target per state, wider than its bar
  const hits = el("g");
  let hover = -1;
  for (let i = 0; i < n; i++) {
    const h = el("rect", { x: M.l + i * band, y: M.t, width: band, height: ph,
                           fill: "transparent" });
    h.addEventListener("pointerenter", () => { hover = i; draw(); });
    h.addEventListener("pointerleave", () => { hover = -1; draw(); });
    hits.append(h);
  }
  svg.append(hand, handLabel, frame, xl, yl, hits);
  q<HTMLElement>("[data-chart]").append(svg);

  /** The bar a time sits over: the elastic one at t = 0, and after that the
   *  place of 1/s = t among the states, which are evenly spaced in log s. */
  const place = (t: number): number => {
    const first = 1 / s[0], step = Math.log(s[0] / s[1]);
    if (t <= 0) return 0;
    return Math.min(Math.max(1 + Math.log(t / first) / step, 0), n - 1);
  };

  function draw() {
    const w = rowAt(table, clock.pos);
    let sum = 0, mag = 0;
    for (let i = 0; i < n; i++) {
      sum += w[i]; mag += Math.abs(w[i]);
      bars[i].setAttribute("d", bar(xc(i) - bw / 2, bw, y(0), y(w[i])));
      bars[i].setAttribute("opacity", hover < 0 || hover === i ? "1" : "0.45");
    }
    const hx = xc(place(axisAt(axis, clock.pos)));
    hand.setAttribute("x1", String(hx)); hand.setAttribute("x2", String(hx));
    handLabel.setAttribute("x", String(hx));
    note.textContent = hover >= 0
      ? `Weight ${fmt(w[hover])} on ${names[hover]}.`
      : `The weights sum to ${sum.toFixed(3)}; their magnitudes sum to ` +
        `${fmt(mag)}, and to as much as ${fmt(most)} within the window.`;
  }

  clock.on(draw);
  clock.setAxis(axis, posOf(axis, 1));
}
