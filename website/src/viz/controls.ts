// Wiring for the Examples viewer: model, quantity, colour, the clock, and
// the profile under it.
//
// The clock is a position in the quantity's table, fractional, so "play" is
// that number advancing. Everything drawn -- the sheets, the colour bar's
// label, the profile, the misfit -- is a function of (model, quantity,
// scalar, position), and `apply` is the only place that calls them.

import { cssGradient } from "./colormaps";
import { axisAt, fmt, Payload, type Model, type Quantity } from "./payload";
import { ProfilePanel } from "./profile";
import { SheetScene, type Scale } from "./scene";
import { ModelView, VECTOR, type Choice } from "./view";

const SWEEP_S = 10;            // seconds for "play" to cross the table once

function quantityName(key: string, q: Quantity): string {
  if (key === "since") return "since the earthquake";
  if (key === "total") return "earthquake included";
  if (key === "rate") return "velocity";
  return `locked fault, earthquakes every ${fmt(q.period ?? 0)} τ`;
}

export function when(q: Quantity, pos: number): string {
  const v = axisAt(q, pos);
  if (q.axis === "phase") {
    return `${(100 * v).toFixed(0)} % of the cycle, ` +
           `${fmt(v * (q.period ?? 1))} τ after the last earthquake`;
  }
  return v <= 0 ? "the earthquake, t = 0⁺" : `t = ${fmt(v)} τ`;
}

export function facts(m: Model): string[] {
  const n = m.numbers, int = (v: number) => Math.round(v).toLocaleString("en-US");
  const out = [
    `${int(n.unknowns)} unknowns on ${int(n.elements)} boundary elements, ` +
    `and no element anywhere else.`,
    `${n.states} elastic solves, one per Laplace state; times from ` +
    `${fmt(m.window[0])} to ${fmt(m.window[1])} Maxwell times.`,
    `A box ${int(2 * n.half_x)} km square and ${int(n.depth)} km deep` +
    (n.sides === "window"
      ? `, whose walls carry the far field of the slip in a layered half-space.`
      : `, its sides ${n.sides}.`),
  ];
  return out;
}

export async function startViewer(root: HTMLElement, baseUrl: string) {
  const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const status = q<HTMLElement>("[data-status]");
  const payload = new Payload(baseUrl);
  try {
    await payload.load();
  } catch (e) {
    status.textContent = `Could not load the data: ${e}`;
    return;
  }

  const scene = new SheetScene(q<HTMLElement>("[data-canvas]"));
  scene.start();
  const view = new ModelView(scene, payload);
  const profile = new ProfilePanel(q<HTMLElement>("[data-profile]"));

  let key = payload.manifest.models[0].key;
  const choice: Choice = { quantity: "since", scalar: "z" };
  let pos = 0, warp = 1, playing = false, last = 0, raf = 0;
  const shown: Record<string, boolean> = {};
  let elements = false, cut = false, first = true;

  // --- controls -----------------------------------------------------------
  const select = (name: string, onChange: (v: string) => void) => {
    const s = document.createElement("select");
    s.addEventListener("change", () => onChange(s.value));
    q<HTMLElement>(`[data-ctl="${name}"]`).append(s);
    return s;
  };
  const fill = (s: HTMLSelectElement, opts: [string, string][], value: string) => {
    s.textContent = "";
    for (const [v, label] of opts) {
      const o = document.createElement("option");
      o.value = v; o.textContent = label; o.selected = v === value;
      s.append(o);
    }
  };

  const modelSel = select("model", (v) => { key = v; void load(); });
  fill(modelSel, payload.manifest.models.map((m) => [m.key, m.label]), key);
  const quantitySel = select("quantity", (v) => {
    const before = rows() - 1;
    choice.quantity = v;
    pos = before > 0 ? pos / before * (rows() - 1) : 0;
    clock.max = String(rows() - 1);
    apply();
  });
  const scalarSel = select("scalar", (v) => { choice.scalar = v; apply(); });
  fill(scalarSel, VECTOR.map((s) => [s.key, s.label]), choice.scalar);

  const clock = q<HTMLInputElement>("[data-clock]");
  clock.addEventListener("input", () => { pos = Number(clock.value); apply(); });
  const play = q<HTMLButtonElement>("[data-play]");
  play.addEventListener("click", () => {
    playing = !playing;
    play.textContent = playing ? "pause" : "play";
    last = 0;
    if (playing) raf = requestAnimationFrame(step); else cancelAnimationFrame(raf);
  });
  const warpIn = q<HTMLInputElement>("[data-warp]");
  warpIn.addEventListener("input", () => { warp = Number(warpIn.value); apply(); });
  const elemIn = q<HTMLInputElement>("[data-elements]");
  elemIn.addEventListener("change", () => { elements = elemIn.checked; visible(); });
  const cutIn = q<HTMLInputElement>("[data-cut]");
  cutIn.addEventListener("change", () => { cut = cutIn.checked; visible(); });

  const rows = () =>
    view.model ? view.quantity(choice).at.length : 1;

  function step(now: number) {
    if (!playing) return;
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    const top = rows() - 1;
    pos += dt / SWEEP_S * top;
    if (pos > top) pos = 0;
    clock.value = String(pos);
    apply();
    raf = requestAnimationFrame(step);
  }

  function visible() {
    for (const name of view.names) {
      const sheet = view.sheet(name);
      sheet?.setVisible(shown[name] ?? true, elements);
      // the near half, toward the camera's first position, taken away
      sheet?.setClip(cut ? [0, 1, 0] : null, 0);
    }
    scene.render();
  }

  // --- colour bars --------------------------------------------------------
  function bar(host: HTMLElement, s: Scale, label: string) {
    host.textContent = "";
    const strip = document.createElement("div");
    strip.className = "strip";
    strip.style.background = cssGradient(s.map);
    const ends = document.createElement("div");
    ends.className = "ends";
    for (const [text, cls] of [[fmt(s.lo), ""], [label, "mid"], [fmt(s.hi), ""]]) {
      const e = document.createElement("span");
      e.textContent = text;
      if (cls) e.className = cls;
      ends.append(e);
    }
    host.append(strip, ends);
  }

  function apply() {
    if (!view.model) return;
    const qn = view.quantity(choice);
    view.set(choice, pos, warp);
    const def = VECTOR.find((s) => s.key === choice.scalar)!;
    const what = qn.label.replace("displacement", `${def.label} displacement`)
      .replace(/^velocity/, `${def.label} velocity`);
    bar(q<HTMLElement>("[data-bar]"), view.scale(choice), `${what} (${qn.unit})`);
    const slip = view.slipScale(choice), slipBar = q<HTMLElement>("[data-slipbar]");
    slipBar.hidden = !slip;
    if (slip) {
      const rate = qn.unit !== "of the slip";
      bar(slipBar, slip, rate
        ? `slip rate on the creeping reach (${qn.unit})`
        : "slip on the creeping reach since the earthquake (of the slip)");
    }
    q<HTMLElement>("[data-when]").textContent = when(qn, pos);
    const label = qn.label.charAt(0).toUpperCase() + qn.label.slice(1);
    profile.set(choice.quantity, pos,
                `${label}, ${qn.unit}; ${when(qn, pos)}.`);
  }

  // --- load ---------------------------------------------------------------
  async function load() {
    status.textContent = "loading…";
    try {
      const m = await view.load(key);
      profile.setData(await payload.profile(m), m);
      const names = Object.keys(m.quantities);
      if (!names.includes(choice.quantity)) choice.quantity = names[0];
      fill(quantitySel, names.map((n) => [n, quantityName(n, m.quantities[n])]),
           choice.quantity);
      // open on the last time, where there is the most to see
      pos = first ? rows() - 1 : Math.min(pos, rows() - 1);
      first = false;
      clock.max = String(rows() - 1);
      clock.value = String(pos);

      const boxes = q<HTMLElement>("[data-sheets]");
      boxes.textContent = "";
      for (const name of view.names) {
        shown[name] = shown[name] ?? true;
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox"; box.checked = shown[name];
        box.addEventListener("change", () => { shown[name] = box.checked; visible(); });
        const text = document.createElement("span");
        text.textContent = m.sheets[name].label;
        label.append(box, text);
        boxes.append(label);
      }
      visible();

      const about = document.querySelector<HTMLElement>("[data-facts]");
      if (about) {
        about.textContent = "";
        const blurb = document.createElement("p");
        blurb.textContent = m.blurb;
        about.append(blurb);
        const list = document.createElement("ul");
        for (const line of facts(m)) {
          const li = document.createElement("li");
          li.textContent = line;
          list.append(li);
        }
        about.append(list);
      }
      apply();
      const src = m.source;
      status.textContent = `${m.label}: run ${src.run} of ${src.study}` +
        (src.mbem_git ? `, mbem ${src.mbem_git}` : "");
    } catch (e) {
      status.textContent = `failed: ${e}`;
    }
  }

  await load();
  return { scene, view };
}
