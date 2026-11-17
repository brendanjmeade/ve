// Wiring for the Examples viewer: model, quantity, colour, the clock, and
// the profile under it.
//
// Everything drawn -- the sheets, the colour bar's label, the profile, the
// misfit -- is a function of (model, quantity, scalar, the clock's position),
// and `apply` is the only place that calls them. The clock is one `Clock`;
// every element marked `data-timeline` gets a slider on it, so the scene and
// the profile each carry one and move together.

import { cssGradient } from "./colormaps";
import { fmt, Payload, type Model, type Quantity } from "./payload";
import { ProfilePanel } from "./profile";
import { SheetScene, type Scale } from "./scene";
import { Clock, Timeline, when } from "./timeline";
import { ModelView, type Choice } from "./view";

function quantityName(key: string, q: Quantity): string {
  if (key === "since") return "since the earthquake";
  if (key === "total") return "earthquake included";
  if (key === "rate") return "velocity";
  return `locked fault, earthquakes every ${fmt(q.period ?? 0)} τ`;
}

export function facts(m: Model): string[] {
  const n = m.numbers, int = (v: number) => Math.round(v).toLocaleString("en-US");
  const sub = n.rheology?.substrate;
  const out = [
    `${int(n.unknowns)} unknowns on ${int(n.elements)} boundary elements, ` +
    `and no element anywhere else.`,
    ...(sub?.kind === "burgers" ? [
      `A Burgers substrate: a transient with time ${fmt(sub.tau_K)} Maxwell ` +
      `times and a Kelvin spring ${fmt(sub.kelvin)} × the shear modulus, in ` +
      `series with the steady flow that sets the clock.`] : []),
    ...(n.slab_depth > n.plate && n.fault_depth > n.plate ? [
      `Below the plate the megathrust runs down the slab's upper face, ` +
      `where slab and mantle wedge slide past each other: slip on an ` +
      `interface between two regions, not a fault inside one.`] : []),
    `${n.states} elastic solves, one per Laplace state; times from ` +
    `${fmt(m.window[0])} to ${fmt(m.window[1])} Maxwell times.`,
    ...(n.stepped ? [
      `The slab's face follows friction that strengthens with slip rate ` +
      `(a σ = ${fmt(1000 * n.creep.fault_lower.a_sigma)} MPa) after ` +
      `${fmt(n.slip_m)} m of slip. That law is not linear, so those solves ` +
      `are only what the face feels: its ${int(n.stepped.slip_unknowns)} ` +
      `slip unknowns were then stepped through time, ` +
      `${int(n.stepped.law_evaluations)} evaluations of the law.`] : []),
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
  const clock = new Clock(12, 1.5);
  for (const host of root.querySelectorAll<HTMLElement>("[data-timeline]")) {
    new Timeline(host, clock);
  }
  clock.on(() => apply());
  const shown: Record<string, boolean> = {};
  let elements = false, cut = false, first = true;

  // --- controls -----------------------------------------------------------
  const select = (name: string, onChange: (v: string) => void | Promise<void>) => {
    const s = document.createElement("select");
    s.addEventListener("change", () => { void onChange(s.value); });
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
    choice.quantity = v;
    clock.setAxis(view.quantity(choice));       // keeps the time; redraws
  });
  const scalarSel = select("scalar", async (v) => {
    choice.scalar = v;
    // a stress is fetched when it is first asked for, not before
    status.textContent = "loading\u2026";
    await view.need(view.def(choice).field);
    status.textContent = provenance();
    apply();
  });

  const elemIn = q<HTMLInputElement>("[data-elements]");
  elemIn.addEventListener("change", () => { elements = elemIn.checked; visible(); });
  const cutIn = q<HTMLInputElement>("[data-cut]");
  cutIn.addEventListener("change", () => { cut = cutIn.checked; visible(); });

  function visible() {
    for (const name of view.names) {
      const sheet = view.sheet(name);
      sheet?.setVisible(shown[name] ?? true, elements);
      // the near half, toward the camera's first position, taken away
      sheet?.setClip(cut && name !== "section" ? [0, 1, 0] : null, 0);
    }
    scene.render();
  }

  // --- colour bars --------------------------------------------------------
  // Rebuilt when what they say changes, not on every frame of the clock.
  const drawn = new WeakMap<HTMLElement, string>();
  function bar(host: HTMLElement, s: Scale, label: string) {
    const sig = `${s.map}|${s.lo}|${s.hi}|${label}`;
    if (drawn.get(host) === sig) return;
    drawn.set(host, sig);
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
    if (!view.model || !clock.axis) return;
    const qn = view.quantity(choice), pos = clock.pos;
    view.set(choice, pos);
    const def = view.def(choice);
    const what = def.field === "sigma"
      ? `${def.label}: ${quantityName(choice.quantity, qn)}`
      : qn.label.replace("displacement", `${def.label} displacement`)
          .replace(/^velocity/, `${def.label} velocity`);
    const scale = view.scale(choice);
    bar(q<HTMLElement>("[data-bar]"), scale,
        `${what} (${view.unit(choice)})${scale.log ? ", log scale" : ""}`);
    const slip = view.slipScale(choice), slipBar = q<HTMLElement>("[data-slipbar]");
    slipBar.hidden = !slip;
    if (slip) {
      const rate = qn.unit !== "of the slip";
      bar(slipBar, slip, rate
        ? `slip rate on the creeping reach (${qn.unit})`
        : "slip on the creeping reach since the earthquake (of the slip)");
    }
    const label = qn.label.charAt(0).toUpperCase() + qn.label.slice(1);
    profile.set(choice.quantity, pos,
                `${label}, ${qn.unit}; ${when(qn, pos)}.`);
  }

  function provenance(): string {
    const m = view.model, src = m.source;
    return `${m.label}: run ${src.run}${src.study ? ` of ${src.study}` : ""}` +
      (src.mbem_git ? `, mbem ${src.mbem_git}` : "");
  }

  // --- load ---------------------------------------------------------------
  async function load() {
    status.textContent = "loading…";
    try {
      const m = await view.load(key);
      profile.setData(await payload.profile(m), m);
      if (!view.scalars.some((s) => s.key === choice.scalar)) choice.scalar = "z";
      fill(scalarSel, view.scalars.map((s) => [s.key, s.label]), choice.scalar);
      await view.need(view.def(choice).field);
      // a model with a section opens as a block diagram: the near half away
      if (first) { cut = "section" in m.sheets; cutIn.checked = cut; }
      const names = Object.keys(m.quantities);
      if (!names.includes(choice.quantity)) choice.quantity = names[0];
      fill(quantitySel, names.map((n) => [n, quantityName(n, m.quantities[n])]),
           choice.quantity);
      // open on the last time, where there is the most to see; after that a
      // new model is shown at the time the last one was left at
      const axis = view.quantity(choice);
      clock.setAxis(axis, first ? axis.at.length - 1 : undefined);
      first = false;

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
      status.textContent = provenance();
    } catch (e) {
      status.textContent = `failed: ${e}`;
    }
  }

  await load();
  return { scene, view };
}
