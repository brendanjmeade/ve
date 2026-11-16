// Loading the payload, and the one piece of arithmetic the page does.
//
// A model is solved once per Laplace state, in Python, and time is a linear
// map of that stack. The map's weights are large and of both signs, so the
// states are not what is shipped: each field arrives as a few orthonormal
// MODES (float32) and, for every quantity of time, a table with one row per
// time. A field at a time is one row times the modes -- `combine` below, a
// dozen multiply-adds per value. The inversion itself is never restated
// here; `mbem.webexport` makes the tables and mbem's gates check them.
//
// Arrays are separate files, fetched on demand and cached, so a visitor who
// looks at one model downloads one model.

export interface ArrayRef { file: string; bytes: number; sha256: string; }

export interface FieldEntry extends ArrayRef {
  components: number;
  modes: number;
  rows: Record<string, number[][]>;
  range: Record<string, Record<string, number>>;
  error: Record<string, number>;
}

export interface SheetEntry {
  label: string;
  nodes: number;
  triangles: number;
  elements: number;
  mesh: { nodes: ArrayRef; triangles: ArrayRef };
  fields: Record<string, FieldEntry>;
  warp: string | null;
}

export interface Quantity {
  axis: "time" | "phase";
  at: number[];
  label: string;
  unit: string;
  period?: number;
}

export interface Model {
  key: string;
  label: string;
  blurb: string;
  source: { study: string; run: string; mbem_git: string | null };
  numbers: Record<string, any>;
  box: { lo: [number, number, number]; hi: [number, number, number] };
  window: [number, number];
  quantities: Record<string, Quantity>;
  sheets: Record<string, SheetEntry>;
  outlines: Record<string, number[][][]>;
  creeping: boolean;
  profile: string;
}

export interface Curve {
  key: string;
  label: string;
  x: number[];
  stack: number[][][];          // [state][point][component]
}

export interface Profile {
  components: string[];
  curves: Curve[];
  misfit: Record<string, Record<string, (number | null)[]>>;
  weights: Record<string, number[][]>;
}

export interface Manifest {
  schema: number;
  models: { key: string; label: string; file: string }[];
}

export class Payload {
  readonly base: string;
  manifest!: Manifest;
  private buffers = new Map<string, Promise<ArrayBuffer>>();
  private docs = new Map<string, Promise<any>>();

  constructor(baseUrl: string) {
    // BASE_URL, never a leading "/data": a hardcoded absolute path works in
    // dev and 404s under the /ve base in production.
    this.base = baseUrl.replace(/\/?$/, "/") + "data/";
  }

  async load(): Promise<Manifest> {
    this.manifest = await this.json("manifest.json");
    return this.manifest;
  }

  private json(file: string): Promise<any> {
    let hit = this.docs.get(file);
    if (!hit) {
      hit = fetch(this.base + file).then((r) => {
        if (!r.ok) throw new Error(`${file}: ${r.status}`);
        return r.json();
      });
      this.docs.set(file, hit);
    }
    return hit;
  }

  model(key: string): Promise<Model> {
    const m = this.manifest.models.find((x) => x.key === key);
    if (!m) throw new Error(`no model ${key}`);
    return this.json(m.file);
  }

  profile(m: Model): Promise<Profile> { return this.json(m.profile); }

  private buffer(ref: ArrayRef): Promise<ArrayBuffer> {
    let hit = this.buffers.get(ref.file);
    if (!hit) {
      hit = fetch(this.base + ref.file).then(async (r) => {
        if (!r.ok) throw new Error(`${ref.file}: ${r.status}`);
        const b = await r.arrayBuffer();
        if (b.byteLength !== ref.bytes) {
          throw new Error(`${ref.file} is ${b.byteLength} bytes, expected ${ref.bytes}`);
        }
        return b;
      });
      this.buffers.set(ref.file, hit);
    }
    return hit;
  }

  async f32(ref: ArrayRef): Promise<Float32Array> {
    return new Float32Array(await this.buffer(ref));
  }

  async u32(ref: ArrayRef): Promise<Uint32Array> {
    return new Uint32Array(await this.buffer(ref));
  }
}

/** Row `pos` of a table, `pos` fractional: the tables are smooth in their
 *  index (log time, or phase), so the rows between are interpolated. */
export function rowAt(rows: number[][], pos: number): Float64Array {
  const last = rows.length - 1;
  const p = Math.min(Math.max(pos, 0), last);
  const i = Math.min(Math.floor(p), Math.max(last - 1, 0));
  const f = p - i;
  const a = rows[i], b = rows[Math.min(i + 1, last)];
  const out = new Float64Array(a.length);
  for (let k = 0; k < a.length; k++) out[k] = a[k] + f * (b[k] - a[k]);
  return out;
}

/** `out = row . modes`: the field at one time. `modes` holds `row.length`
 *  blocks of `out.length` values. */
export function combine(modes: Float32Array, row: ArrayLike<number>,
                        out: Float32Array): Float32Array {
  const n = out.length;
  out.fill(0);
  for (let r = 0; r < row.length; r++) {
    const c = row[r], o = r * n;
    if (c === 0) continue;
    for (let i = 0; i < n; i++) out[i] += c * modes[o + i];
  }
  return out;
}

/** The value of a table's axis at a fractional row, for the readout. Times
 *  are log-spaced after the first (t = 0), so they are interpolated in log. */
export function axisAt(q: Quantity, pos: number): number {
  const at = q.at, last = at.length - 1;
  const p = Math.min(Math.max(pos, 0), last);
  const i = Math.min(Math.floor(p), Math.max(last - 1, 0));
  const f = p - i, a = at[i], b = at[Math.min(i + 1, last)];
  if (q.axis === "time" && a > 0 && b > 0) return a * Math.pow(b / a, f);
  return a + f * (b - a);
}

export function fmt(v: number, digits = 3): string {
  if (!isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a < 1e-3 || a >= 1e4) return v.toExponential(1).replace("e-", "e−");
  return v.toPrecision(digits).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")
    .replace("-", "−");
}
