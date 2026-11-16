// The clock a moving figure runs on, and the slider that shows it.
//
// A clock is a position in a quantity's table, fractional: row 0 is the
// earthquake (or the start of a cycle) and the last row the end of the fit's
// window. "Play" is that number advancing. A Timeline is a play button, a
// slider marked with the table's own axis, and the time in words. Any number
// of timelines can show one clock, so a figure further down a page carries a
// slider of its own and stays in step with the one above it.
//
// The slider is linear in the ROW, and the rows are log-spaced in time after
// the first, so the marks on it are decades. Nothing here knows what a row
// holds; whoever draws subscribes with `on`.

import { axisAt, fmt, type Quantity } from "./payload";

/** The time of a fractional row, in words. */
export function when(q: Quantity, pos: number): string {
  const v = axisAt(q, pos);
  if (q.axis === "phase") {
    return `${(100 * v).toFixed(0)} % of the cycle, ` +
           `${fmt(v * (q.period ?? 1))} τ after the last earthquake`;
  }
  return v <= 0 ? "the earthquake, t = 0⁺" : `t = ${fmt(v)} τ`;
}

/** The fractional row at which a table's axis has the value `v`: the inverse
 *  of `axisAt`, clamped to the table. */
export function posOf(q: Quantity, v: number): number {
  const at = q.at, last = at.length - 1;
  if (v <= at[0]) return 0;
  if (v >= at[last]) return last;
  let i = 0;
  while (i < last - 1 && at[i + 1] < v) i++;
  const a = at[i], b = at[i + 1];
  const f = q.axis === "time" && a > 0
    ? Math.log(v / a) / Math.log(b / a) : (v - a) / (b - a);
  return i + f;
}

export class Clock {
  pos = 0;
  playing = false;
  axis: Quantity | null = null;
  private subs: (() => void)[] = [];
  private raf = 0;
  private last = 0;
  private rested = 0;

  /** `sweep`: seconds for play to cross a table. `rest`: seconds it stays on
   *  the last row before it starts again. */
  constructor(private sweep = 12, private rest = 1.5) {}

  get top(): number { return this.axis ? this.axis.at.length - 1 : 1; }

  /** Call `fn` whenever the position, the table or play/pause changes. */
  on(fn: () => void) { this.subs.push(fn); }
  private emit() { for (const fn of this.subs) fn(); }

  /** Another table. Unless `pos` is given the clock keeps its TIME where
   *  both tables are in time, and otherwise its place as a fraction. */
  setAxis(q: Quantity, pos?: number) {
    const was = this.axis;
    if (pos === undefined) {
      if (!was) pos = 0;
      else if (was.axis === "time" && q.axis === "time") {
        pos = posOf(q, axisAt(was, this.pos));
      } else pos = this.pos / this.top * (q.at.length - 1);
    }
    this.axis = q;
    this.pos = Math.min(Math.max(pos, 0), this.top);
    this.emit();
  }

  set(pos: number) {
    this.pos = Math.min(Math.max(pos, 0), this.top);
    this.rested = 0;
    this.emit();
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this.last = 0;
    this.rested = 0;
    if (this.pos >= this.top) this.pos = 0;      // from the end: start over
    this.raf = requestAnimationFrame(this.step);
    this.emit();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  toggle() { if (this.playing) this.pause(); else this.play(); }

  private step = (now: number) => {
    if (!this.playing) return;
    // a tab that was in the background comes back with one long frame
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0;
    this.last = now;
    const top = this.top;
    if (this.pos >= top) {
      this.rested += dt;
      if (this.rested >= this.rest) { this.rested = 0; this.pos = 0; this.emit(); }
    } else {
      this.pos = Math.min(this.pos + dt / this.sweep * top, top);
      this.emit();
    }
    this.raf = requestAnimationFrame(this.step);
  };
}

/** The marks of a table's axis: `[fraction along the slider, label]`. A mark
 *  with an empty label is drawn and not named. */
function marks(q: Quantity): [number, string][] {
  const top = q.at.length - 1;
  const out: [number, string][] = [];
  if (q.axis === "phase") {
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      out.push([posOf(q, v) / top, `${100 * v}${v === 1 ? " %" : ""}`]);
    }
    return out;
  }
  const first = q.at.find((v) => v > 0) ?? 1, last = q.at[top];
  if (q.at[0] <= 0) out.push([0, "0"]);
  for (let k = Math.ceil(Math.log10(first) - 1e-9);
       k <= Math.floor(Math.log10(last) + 1e-9); k++) {
    const v = 10 ** k, f = posOf(q, v) / top;
    // a decade too close to the earthquake's own mark keeps its tick only
    const crowded = out.length > 0 && out[0][0] === 0 && f < 0.07 && f > 0;
    out.push([f, crowded ? "" : fmt(v)]);
  }
  const end = out[out.length - 1];
  if (end && end[1]) end[1] += " τ";
  return out;
}

export class Timeline {
  private button: HTMLButtonElement;
  private range: HTMLInputElement;
  private ticks: HTMLElement;
  private now: HTMLElement;
  private shown: Quantity | null = null;

  /** Build the slider inside `host` (an empty element) and bind it to
   *  `clock`. */
  constructor(private host: HTMLElement, private clock: Clock) {
    host.classList.add("timeline");
    host.textContent = "";
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string) => {
      const e = document.createElement(tag);
      e.className = cls;
      return e;
    };
    this.button = el("button", "play");
    this.button.type = "button";
    this.button.textContent = "play";
    this.button.disabled = true;
    const track = el("div", "track");
    this.range = el("input", "");
    this.range.type = "range";
    this.range.min = "0"; this.range.max = "1"; this.range.step = "0.25";
    this.range.value = "0";
    this.range.disabled = true;
    this.range.setAttribute("aria-label", "time");
    this.ticks = el("div", "ticks");
    this.ticks.setAttribute("aria-hidden", "true");
    track.append(this.range, this.ticks);
    this.now = el("output", "now");
    host.append(this.button, track, this.now);

    this.button.addEventListener("click", () => clock.toggle());
    // taking the slider takes the clock: it stops where it is put
    this.range.addEventListener("input", () => {
      clock.pause();
      clock.set(Number(this.range.value));
    });
    clock.on(() => this.draw());
    this.draw();
  }

  /** Words in place of the time, before there is one (loading, a failure). */
  say(text: string) { this.now.textContent = text; }

  private draw() {
    const c = this.clock, q = c.axis;
    if (!q) return;
    if (q !== this.shown) {
      this.shown = q;
      this.button.disabled = this.range.disabled = false;
      this.range.max = String(c.top);
      this.range.setAttribute("aria-label", q.axis === "phase"
        ? "time through the cycle" : "time since the earthquake");
      this.ticks.textContent = "";
      for (const [f, label] of marks(q)) {
        const m = document.createElement("span");
        m.style.left = `${(100 * f).toFixed(3)}%`;
        m.textContent = label;
        this.ticks.append(m);
      }
    }
    this.range.value = String(c.pos);
    this.host.style.setProperty("--f", String(c.top ? c.pos / c.top : 0));
    const text = when(q, c.pos);
    this.range.setAttribute("aria-valuetext", text);
    this.now.textContent = text;
    const label = c.playing ? "pause" : "play";
    if (this.button.textContent !== label) this.button.textContent = label;
  }
}
