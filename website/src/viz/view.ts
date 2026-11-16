// One model in a scene: its sheets built from the payload, and the one
// function that moves all of them to a time.
//
// The hero and the Examples viewer both use this, so "what is drawn at time
// t" is written once: for every sheet, one row of the quantity's table times
// the field's modes; the scalar asked for goes to the colour, and the vector
// itself, exaggerated, displaces the sheet.

import type { MapName } from "./colormaps";
import {
  combine, rowAt, type FieldEntry, type Model, type Payload, type Quantity,
} from "./payload";
import { type Scale, type Sheet, SheetScene } from "./scene";

/** A scalar a viewer can colour by. `sign` picks the colour map: a signed
 *  quantity diverges about zero, a magnitude runs from zero up. */
export interface ScalarDef { key: string; label: string; signed: boolean; }

export const VECTOR: ScalarDef[] = [
  { key: "z", label: "vertical", signed: true },
  { key: "x", label: "horizontal, across the trench", signed: true },
  { key: "y", label: "horizontal, along strike", signed: true },
  { key: "mag", label: "magnitude", signed: false },
];

export interface Choice { quantity: string; scalar: string; }

interface Loaded {
  sheet: Sheet;
  name: string;
  warp: string | null;
  fields: Map<string, { entry: FieldEntry; modes: Float32Array; at: Float32Array }>;
}

const PINK = 0xb5367a;

export class ModelView {
  model!: Model;
  private loaded: Loaded[] = [];

  constructor(readonly scene: SheetScene, readonly payload: Payload) {}

  /** Fetch a model and build its sheets. `depth` is how far down the box is
   *  drawn, km. */
  async load(key: string, depth = 150): Promise<Model> {
    const m = await this.payload.model(key);
    const names = Object.keys(m.sheets);
    const parts = await Promise.all(names.map(async (name) => {
      const sh = m.sheets[name];
      const [nodes, tris, ...modes] = await Promise.all([
        this.payload.f32(sh.mesh.nodes), this.payload.u32(sh.mesh.triangles),
        ...Object.values(sh.fields).map((f) => this.payload.f32(f)),
      ]);
      return { name, sh, nodes, tris, modes };
    }));

    this.scene.clear();
    this.loaded = [];
    this.model = m;
    for (const { name, sh, nodes, tris, modes } of parts) {
      // The buffer the payload cached is shared; the geometry gets a copy
      // so disposing a model cannot detach it.
      const sheet = this.scene.add(name, nodes.slice(), tris.slice());
      const fields = new Map();
      Object.entries(sh.fields).forEach(([f, entry], i) => {
        fields.set(f, { entry, modes: modes[i],
                        at: new Float32Array(sh.nodes * entry.components) });
      });
      this.loaded.push({ sheet, name, warp: sh.warp, fields });
    }
    this.scene.frame(m.box.lo, m.box.hi, depth);
    for (const seg of Object.values(m.outlines)) this.scene.addLines(seg, PINK);
    return m;
  }

  quantity(c: Choice): Quantity { return this.model.quantities[c.quantity]; }

  /** The limit of one scalar of the displacement, over every sheet that
   *  carries it, so the sheets share one colour bar. */
  private limit(q: string, key: string): number {
    let hi = 0;
    for (const l of this.loaded) {
      const u = l.fields.get("u");
      if (u) hi = Math.max(hi, u.entry.range[q]?.[key] ?? 0);
    }
    return hi || 1;
  }

  scale(c: Choice): Scale {
    const def = VECTOR.find((s) => s.key === c.scalar) ?? VECTOR[0];
    const hi = this.limit(c.quantity, def.key);
    return def.signed
      ? { lo: -hi, hi, log: false, map: "rdbu_r" }
      : { lo: 0, hi, log: false, map: "viridis" };
  }

  /** The creeping reach has its own scale: slip is not a displacement of
   *  the ground and would be invisible on the ground's colour bar. */
  slipScale(c: Choice): Scale | null {
    const f = this.loaded.find((l) => l.fields.has("slip"))?.fields.get("slip");
    if (!f) return null;
    const hi = f.entry.range[c.quantity]?.value || 1;
    const grows = c.quantity === "since" || c.quantity === "total";
    return grows ? { lo: 0, hi, log: false, map: "plasma" as MapName }
                 : { lo: -hi, hi, log: false, map: "rdbu_r" as MapName };
  }

  /** Move every sheet to row `pos` of the chosen quantity. `warp` is the
   *  exaggeration as a fraction of its default (1 = the largest
   *  displacement of the quantity drawn 7 % of the box wide). */
  set(c: Choice, pos: number, warp: number) {
    const comp = { x: 0, y: 1, z: 2 }[c.scalar as "x" | "y" | "z"];
    const top = this.limit(c.quantity, "max");
    const factor = warp * 0.07 * this.scene.size.x / top;
    const scale = this.scale(c), slip = this.slipScale(c);
    for (const l of this.loaded) {
      const u = l.fields.get("u"), s = l.fields.get("slip");
      const value = l.sheet.value, disp = l.sheet.disp;
      if (u) {
        combine(u.modes, rowAt(u.entry.rows[c.quantity], pos), u.at);
        const a = u.at;
        if (comp === undefined) {
          for (let i = 0, j = 0; i < value.length; i++, j += 3) {
            value[i] = Math.hypot(a[j], a[j + 1], a[j + 2]);
          }
        } else {
          for (let i = 0, j = comp; i < value.length; i++, j += 3) value[i] = a[j];
        }
        if (l.warp === "u") disp.set(a);
        l.sheet.setScale(scale);
        l.sheet.setWarp(l.warp === "u" ? factor : 0);
      } else if (s && slip) {
        combine(s.modes, rowAt(s.entry.rows[c.quantity], pos), s.at);
        value.set(s.at);
        l.sheet.setScale(slip);
        l.sheet.setWarp(0);
      }
      l.sheet.touch();
    }
    this.scene.render();
  }

  sheet(name: string): Sheet | undefined {
    return this.loaded.find((l) => l.name === name)?.sheet;
  }

  get names(): string[] { return this.loaded.map((l) => l.name); }
}
