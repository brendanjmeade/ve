// How two materials let go of a stress: the Theory page's second figure.
//
// The relaxation modulus mu(t)/mu of a Maxwell material and of the Burgers
// material of the model on this site, on one log-time axis, under a slider.
// Both are closed forms of the material alone -- an exponential, and the two
// exponentials a Burgers modulus splits into -- so they are evaluated here;
// nothing of a solve or of its inversion is. The Burgers parameters are read
// from the model that was solved with them.
//
// Colour is identity, as in the profile: the model blue, what it is compared
// with orange. The legend names them and the readout is ink.

import { fmt, Payload, type Quantity } from "./payload";
import { Clock, posOf, Timeline } from "./timeline";

const NS = "http://www.w3.org/2000/svg";
const W = 760, H = 250, M = { l: 44, r: 16, t: 14, b: 46 };
const BLUE = "#2a78d6", ORANGE = "#eb6834";
const T0 = 0.01, T1 = 100;

function el<K extends keyof SVGElementTagNameMap>(
  tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** The two Maxwell branches of a Burgers material: times `tau` and
 *  fractions `A` of the unrelaxed modulus, from its steady time, transient
 *  time and Kelvin-spring ratio. The roots of
 *  k tM tK s^2 + (k tM + k tK + tM) s + k. */
export function branches(tM: number, tK: number, k: number) {
  const a = k * tM * tK, b = k * tM + k * tK + tM, c = k;
  const d = Math.sqrt(b * b - 4 * a * c);
  const r = [(b + d) / (2 * a), (b - d) / (2 * a)];        // rates, fast first
  const A = [(1 / tK - r[0]) / (r[1] - r[0]), (1 / tK - r[1]) / (r[0] - r[1])];
  return { tau: [1 / r[0], 1 / r[1]], A };
}

export async function startRelaxation(root: HTMLElement, baseUrl: string) {
  const q = <T extends Element>(s: string) => root.querySelector<T>(s)!;
  const note = q<HTMLElement>("[data-note]");
  const clock = new Clock(14, 1.5);
  const timeline = new Timeline(q<HTMLElement>("[data-timeline]"), clock);
  timeline.say("loading…");

  let tM = 1, tK = 0.1, k = 1;
  try {
    const payload = new Payload(baseUrl);
    await payload.load();
    const sub = (await payload.model("burgers")).numbers.rheology?.substrate;
    if (sub?.kind !== "burgers") throw new Error("not a Burgers model");
    tM = sub.tau_M; tK = sub.tau_K; k = sub.kelvin;
  } catch {
    timeline.say("The Burgers model is not available in this build.");
    return;
  }
  const br = branches(tM, tK, k);
  const maxwell = (t: number) => Math.exp(-t / tM);
  const burgers = (t: number) =>
    br.A[0] * Math.exp(-t / br.tau[0]) + br.A[1] * Math.exp(-t / br.tau[1]);

  const pw = W - M.l - M.r, ph = H - M.t - M.b;
  const x = (t: number) => M.l + pw * Math.log(Math.max(t, T0) / T0) / Math.log(T1 / T0);
  const y = (v: number) => M.t + ph * (1 - v);

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  svg.setAttribute("aria-label",
    "The fraction of a stress still held at time t after a step of strain, " +
    "for a Maxwell material and for the Burgers material of the model");
  for (let d = Math.round(Math.log10(T0)); d <= Math.round(Math.log10(T1)); d++) {
    const t = el("text", { x: x(10 ** d), y: H - M.b + 15, "text-anchor": "middle", class: "tick" });
    t.textContent = fmt(10 ** d);
    svg.append(t);
  }
  for (const v of [0, 0.5, 1]) {
    const t = el("text", { x: M.l - 6, y: y(v) + 4, "text-anchor": "end", class: "tick" });
    t.textContent = fmt(v);
    svg.append(t);
  }
  const xl = el("text", { x: M.l + pw / 2, y: H - 8, "text-anchor": "middle", class: "lab" });
  xl.textContent = "time since the step of strain (Maxwell times)";
  const yl = el("text", { x: 12, y: M.t + ph / 2, "text-anchor": "middle", class: "lab",
                          transform: `rotate(-90 12 ${M.t + ph / 2})` });
  yl.textContent = "stress still held";
  const path = (f: (t: number) => number) => {
    let d = "";
    for (let i = 0; i <= 240; i++) {
      const t = T0 * Math.pow(T1 / T0, i / 240);
      d += `${i ? "L" : "M"}${x(t).toFixed(1)},${y(f(t)).toFixed(1)}`;
    }
    return d;
  };
  svg.append(
    el("path", { d: path(maxwell), fill: "none", stroke: ORANGE, "stroke-width": 2 }),
    el("path", { d: path(burgers), fill: "none", stroke: BLUE, "stroke-width": 2 }));
  const hair = el("line", { y1: M.t, y2: H - M.b, stroke: "#888", "stroke-width": 0.8 });
  const dots = [ORANGE, BLUE].map((c) =>
    el("circle", { r: 4.5, fill: c, stroke: "#fff", "stroke-width": 2 }));
  const frame = el("rect", { x: M.l, y: M.t, width: pw, height: ph, fill: "none",
                             stroke: "#222", "stroke-width": 0.8 });
  svg.append(hair, ...dots, frame, xl, yl);
  q<HTMLElement>("[data-chart]").append(svg);

  // the slider's own axis: the chart's, with the step itself as its first stop
  const n = 64;
  const axis: Quantity = {
    axis: "time", label: "", unit: "",
    at: [0, ...Array.from({ length: n + 1 }, (_, i) => T0 * Math.pow(T1 / T0, i / n))],
  };

  function draw() {
    const pos = clock.pos, at = axis.at;
    const i = Math.min(Math.floor(pos), at.length - 2), f = pos - i;
    const t = i === 0 ? f * at[1] : at[i] * Math.pow(at[i + 1] / at[i], f);
    const m = maxwell(t), b = burgers(t);
    hair.setAttribute("x1", String(x(t))); hair.setAttribute("x2", String(x(t)));
    dots[0].setAttribute("cx", String(x(t))); dots[0].setAttribute("cy", String(y(m)));
    dots[1].setAttribute("cx", String(x(t))); dots[1].setAttribute("cy", String(y(b)));
    note.textContent =
      `Maxwell holds ${m.toFixed(3)} of the stress and Burgers ${b.toFixed(3)}. ` +
      `The Burgers branches: ${br.A[0].toFixed(3)} with time ${fmt(br.tau[0])}, ` +
      `${br.A[1].toFixed(3)} with time ${fmt(br.tau[1])}.`;
  }
  clock.on(draw);
  clock.setAxis(axis, posOf(axis, 0.3));
}
