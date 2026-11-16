// The landing page's scene: the megathrust, moving. No controls; the clock
// loops from the earthquake to the end of the fit's window and a slow orbit
// runs until the visitor takes the camera.

import { Payload } from "./payload";
import { SheetScene } from "./scene";
import { ModelView, type Choice } from "./view";
import { when } from "./controls";

const LOOP_S = 14;             // one pass of the clock, seconds
const HOLD = 0.12;             // of the loop, resting on the last frame

export async function startHero(el: HTMLElement, baseUrl: string) {
  const payload = new Payload(baseUrl);
  const scene = new SheetScene(el);
  const view = new ModelView(scene, payload);
  const choice: Choice = { quantity: "since", scalar: "z" };
  try {
    await payload.load();
    await view.load(payload.manifest.models[0].key);
  } catch {
    el.textContent = "The model data is not available in this build.";
    return;
  }
  scene.start();
  const readout = document.createElement("div");
  readout.className = "clock";
  el.append(readout);

  const q = view.quantity(choice);
  const top = q.at.length - 1;
  let idle = true, angle = -1.1, t0 = 0;
  el.addEventListener("pointerdown", () => { idle = false; }, { once: true });
  el.addEventListener("wheel", () => { idle = false; }, { once: true });

  // A visitor who asked for less motion gets the last frame, still.
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    view.set(choice, top, 1);
    readout.textContent = when(q, top);
    return scene;
  }

  const tick = (now: number) => {
    t0 = t0 || now;
    const phase = ((now - t0) / 1000 / LOOP_S) % 1;
    const pos = Math.min(phase / (1 - HOLD), 1) * top;
    if (idle) {
      angle += 0.0009;
      scene.place(angle, 0.5);
    }
    view.set(choice, pos, 1);
    readout.textContent = when(q, pos);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return scene;
}
