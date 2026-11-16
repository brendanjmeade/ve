// One model in a scene: its sheets built from the payload, and the one
// function that moves all of them to a time.
//
// The hero and the Examples viewer both use this, so "what is drawn at time
// t" is written once: for every sheet, one row of the quantity's table times
// the field's modes, and the scalar asked for goes to the colour. The sheets
// themselves do not move (see scene.ts).

import type { MapName } from "./colormaps";
import {
  combine, rowAt, type FieldEntry, type Model, type Payload, type Quantity,
} from "./payload";
import { type Scale, type Sheet, SheetScene } from "./scene";

/** A scalar a viewer can colour by, and the field it is made from. A signed
 *  one diverges about zero; a magnitude runs up from zero, or over decades
 *  when `log` (a stress spans five). */
export interface ScalarDef {
  key: string;
  label: string;
  field: "u" | "sigma";
  signed: boolean;
  log?: boolean;
}

export const SCALARS: ScalarDef[] = [
  { key: "z", label: "vertical", field: "u", signed: true },
  { key: "x", label: "horizontal, across the trench", field: "u", signed: true },
  { key: "y", label: "horizontal, along strike", field: "u", signed: true },
  { key: "mag", label: "magnitude", field: "u", signed: false },
  { key: "von_mises", label: "deviatoric stress", field: "sigma", signed: false,
    log: true },
];

export interface Choice { quantity: string; scalar: string; }

interface Held { entry: FieldEntry; modes: Float32Array; at: Float32Array; }

interface Loaded {
  sheet: Sheet;
  name: string;
  fields: Map<string, Held>;
}

const PINK = 0xb5367a;

/** von Mises of a symmetric tensor stored (xx, yy, zz, xy, yz, xz): the
 *  size of its deviatoric part, sqrt(3 J2). Of the tensor AT this time --
 *  never a difference of two von Mises values, which is not one. */
function vonMises(a: Float32Array, out: Float32Array) {
  for (let i = 0, j = 0; i < out.length; i++, j += 6) {
    const xx = a[j], yy = a[j + 1], zz = a[j + 2];
    const xy = a[j + 3], yz = a[j + 4], xz = a[j + 5];
    out[i] = Math.sqrt(0.5 * ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2)
                       + 3 * (xy * xy + yz * yz + xz * xz));
  }
}

export class ModelView {
  model!: Model;
  private loaded: Loaded[] = [];

  constructor(readonly scene: SheetScene, readonly payload: Payload) {}

  /** Fetch a model and build its sheets. Only the fields in `want` are
   *  fetched now (a stress is megabytes nobody may ask for); `need` gets
   *  another later. `only` names the sheets to build, for a scene that
   *  shows fewer than the model has. */
  async load(key: string, want: string[] = ["u", "slip"],
             only?: string[]): Promise<Model> {
    const m = await this.payload.model(key);
    const names = Object.keys(m.sheets)
      .filter((n) => !only || only.includes(n));
    const parts = await Promise.all(names.map(async (name) => {
      const sh = m.sheets[name];
      const fields = Object.keys(sh.fields).filter((f) => want.includes(f));
      const [nodes, tris, ...modes] = await Promise.all([
        this.payload.f32(sh.mesh.nodes), this.payload.u32(sh.mesh.triangles),
        ...fields.map((f) => this.payload.f32(sh.fields[f])),
      ]);
      return { name, sh, nodes, tris, fields, modes };
    }));

    this.scene.clear();
    this.loaded = [];
    this.model = m;
    for (const { name, sh, nodes, tris, fields, modes } of parts) {
      // The buffer the payload cached is shared; the geometry gets a copy
      // so disposing a model cannot detach it.
      const sheet = this.scene.add(name, nodes.slice(), tris.slice());
      const held = new Map<string, Held>();
      fields.forEach((f, i) => {
        const entry = sh.fields[f];
        held.set(f, { entry, modes: modes[i],
                      at: new Float32Array(sh.nodes * entry.components) });
      });
      this.loaded.push({ sheet, name, fields: held });
    }
    this.scene.frame(m.box.lo, m.box.hi, m.view_depth ?? 150);
    for (const seg of Object.values(m.outlines)) this.scene.addLines(seg, PINK);
    return m;
  }

  /** Make sure `field` is in memory wherever the model has it. */
  async need(field: string) {
    await Promise.all(this.loaded.map(async (l) => {
      const entry = this.model.sheets[l.name].fields[field];
      if (!entry || l.fields.has(field)) return;
      const modes = await this.payload.f32(entry);
      l.fields.set(field, { entry, modes,
        at: new Float32Array(this.model.sheets[l.name].nodes * entry.components) });
    }));
  }

  /** The scalars this model can be coloured by. */
  get scalars(): ScalarDef[] {
    const have = new Set<string>();
    for (const sh of Object.values(this.model.sheets)) {
      for (const f of Object.keys(sh.fields)) have.add(f);
    }
    return SCALARS.filter((s) => have.has(s.field));
  }

  quantity(c: Choice): Quantity { return this.model.quantities[c.quantity]; }

  def(c: Choice): ScalarDef {
    return SCALARS.find((s) => s.key === c.scalar) ?? SCALARS[0];
  }

  /** What the colour bar's numbers are in. */
  unit(c: Choice): string {
    const d = this.def(c);
    for (const sh of Object.values(this.model.sheets)) {
      const u = sh.fields[d.field]?.unit?.[c.quantity];
      if (u) return u;
    }
    return this.quantity(c).unit;
  }

  /** A limit of one field over every sheet that carries it (from the
   *  model's own record, so it does not wait for the field to load), so the
   *  sheets share one colour bar. */
  private limit(field: string, q: string, key: string): number {
    let hi = 0;
    for (const l of this.loaded) {
      const sh = this.model.sheets[l.name];
      hi = Math.max(hi, sh.fields[field]?.range[q]?.[key] ?? 0);
    }
    return hi || 1;
  }

  scale(c: Choice): Scale {
    const d = this.def(c);
    const hi = this.limit(d.field, c.quantity, d.key);
    if (d.signed) return { lo: -hi, hi, log: false, map: "rdbu_r" };
    // three decades below the top: the mantle's stress falls through all of
    // them as it relaxes, and off the bottom
    if (d.log) return { lo: hi / 1000, hi, log: true, map: "plasma" };
    return { lo: 0, hi, log: false, map: "viridis" };
  }

  /** The creeping reach has its own scale: slip is not a displacement of
   *  the ground and would be invisible on the ground's colour bar. */
  slipScale(c: Choice): Scale | null {
    const f = Object.values(this.model.sheets)
      .map((sh) => sh.fields.slip).find(Boolean);
    if (!f) return null;
    const hi = f.range[c.quantity]?.value || 1;
    const grows = c.quantity === "since" || c.quantity === "total";
    return grows ? { lo: 0, hi, log: false, map: "plasma" as MapName }
                 : { lo: -hi, hi, log: false, map: "rdbu_r" as MapName };
  }

  /** Colour every sheet by row `pos` of the chosen quantity. A field is
   *  combined only where it is the one being drawn. */
  set(c: Choice, pos: number) {
    const d = this.def(c);
    const comp = { x: 0, y: 1, z: 2 }[d.key as "x" | "y" | "z"];
    const scale = this.scale(c), slip = this.slipScale(c);
    for (const l of this.loaded) {
      const u = l.fields.get("u"), s = l.fields.get("slip");
      const sig = l.fields.get("sigma");
      const value = l.sheet.value;
      if (s && slip) {
        combine(s.modes, rowAt(s.entry.rows[c.quantity], pos), s.at);
        value.set(s.at);
        l.sheet.setScale(slip);
        l.sheet.setPlain(false);
      } else if (d.field === "u" && u) {
        const a = combine(u.modes, rowAt(u.entry.rows[c.quantity], pos), u.at);
        if (comp === undefined) {
          for (let i = 0, j = 0; i < value.length; i++, j += 3) {
            value[i] = Math.hypot(a[j], a[j + 1], a[j + 2]);
          }
        } else {
          for (let i = 0, j = comp; i < value.length; i++, j += 3) value[i] = a[j];
        }
        l.sheet.setScale(scale);
        l.sheet.setPlain(false);
      } else if (d.field === "sigma" && sig) {
        combine(sig.modes, rowAt(sig.entry.rows[c.quantity], pos), sig.at);
        vonMises(sig.at, value);
        l.sheet.setScale(scale);
        l.sheet.setPlain(false);
      } else {
        l.sheet.setPlain(true);       // nothing of this quantity lives here
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
