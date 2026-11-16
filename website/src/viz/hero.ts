// The landing page's scene: the megathrust, moving. The clock plays from the
// earthquake to the end of the fit's window and starts again, under a slider
// the visitor can take, and a slow sway runs until they take the camera.

import { Payload } from "./payload";
import { SheetScene } from "./scene";
import { Clock, Timeline } from "./timeline";
import { ModelView, type Choice } from "./view";

export async function startHero(el: HTMLElement, bar: HTMLElement,
                                baseUrl: string) {
  const payload = new Payload(baseUrl);
  const scene = new SheetScene(el);
  const view = new ModelView(scene, payload);
  const choice: Choice = { quantity: "since", scalar: "z" };
  const clock = new Clock(14, 1.7);
  const timeline = new Timeline(bar, clock);
  timeline.say("loading the model…");
  try {
    await payload.load();
    const first = payload.manifest.models[0];
    const m = await payload.model(first.key);
    // In a block diagram the base of the plate is edge-on in the cut and
    // hidden everywhere else: not worth its megabyte here.
    await view.load(first.key, ["u"],
                    "section" in m.sheets ? ["top", "section"] : undefined);
  } catch {
    timeline.say("The model data is not available in this build.");
    return;
  }
  scene.start();
  // With a section the scene is a block diagram: the near half of the
  // surface and of the plate's base taken away, the section facing out.
  const block = !!view.sheet("section");
  if (block) {
    for (const name of view.names) {
      if (name !== "section") view.sheet(name)!.setClip([0, 1, 0], 0);
    }
  }

  // A visitor who asked for less motion gets the last frame, still, and a
  // slider and a play button that move it only when they do.
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let idle = !still, moved = true, angle = -1.1, t0 = 0;
  el.addEventListener("pointerdown", () => { idle = false; }, { once: true });
  el.addEventListener("wheel", () => { idle = false; }, { once: true });
  scene.place(block ? -1.25 : angle, block ? 0.36 : 0.5);

  const q = view.quantity(choice);
  clock.on(() => { moved = true; });
  clock.setAxis(q, still ? q.at.length - 1 : 0);
  if (!still) clock.play();

  // One frame, one draw: the fields are recomputed only when the clock has
  // moved, and the sway alone redraws what is already there.
  const tick = (now: number) => {
    t0 = t0 || now;
    if (idle) {
      // a block diagram sways in front of its cut face; a surface turns
      angle = block ? -1.25 + 0.4 * Math.sin((now - t0) / 9000) : angle + 0.0009;
      scene.place(angle, block ? 0.36 : 0.5);
    }
    if (moved) { view.set(choice, clock.pos, 1); moved = false; }
    else if (idle) scene.render();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return scene;
}
