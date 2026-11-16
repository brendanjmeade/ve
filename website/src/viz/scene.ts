// Sheets in a rotatable 3-D scene: the free surface, the base of the plate,
// a fault, a section through the volume.
//
// A sheet is a triangle mesh with two things at its nodes that change with
// time: a scalar, which the fragment shader turns into a colour, and a
// displacement, which the vertex shader adds to the node, exaggerated. Both
// are plain vertex attributes written from the CPU each time the clock
// moves, so there is no float texture anywhere -- a float texture cannot be
// linearly filtered on about half of iOS devices and fails as a black
// surface, not as an error -- and the rasteriser does the interpolation.
//
// The colour scale (limits, linear or log) is a pair of uniforms per sheet,
// so changing it never touches the data.

import {
  BufferAttribute, BufferGeometry, Color, DataTexture, DoubleSide,
  DynamicDrawUsage, Float32BufferAttribute, GLSL3, Group, LinearFilter,
  LineBasicMaterial, LineSegments, Mesh, PerspectiveCamera, RGBAFormat, Scene,
  ShaderMaterial, Vector2, Vector3, Vector4, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { lut, type MapName } from "./colormaps";

const VERT = `
attribute vec3 aDisp;
attribute float aValue;
uniform float uWarp;
varying float vValue;
varying vec3 vRest;
varying vec3 vWorld;
void main() {
  vValue = aValue;
  vRest = position;
  vec4 world = modelMatrix * vec4(position + uWarp * aDisp, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

// The output is declared here because GLSL3 is requested: three.js injects
// the gl_FragColor alias only when it is not, and writing gl_FragColor under
// "#version 300 es" fails to compile with an error no build step sees.
const FRAG = `
precision highp float;
layout(location = 0) out vec4 fragColor;
varying float vValue;
varying vec3 vRest;
varying vec3 vWorld;
uniform sampler2D uLut;
uniform float uLo, uHi, uShade, uOpacity;
uniform bool uLog, uWire, uPlain;
uniform vec4 uClip;            // keep where dot(rest, uClip.xyz) >= uClip.w
uniform vec3 uWireColor;
void main() {
  if (dot(vRest, uClip.xyz) < uClip.w) discard;
  if (uWire) { fragColor = vec4(uWireColor, uOpacity); return; }
  float t = uLog
    ? (log(max(vValue, 1e-30)) - log(uLo)) / (log(uHi) - log(uLo))
    : (vValue - uLo) / (uHi - uLo);
  vec3 c = uPlain ? vec3(0.93) : texture(uLut, vec2(clamp(t, 0.0, 1.0), 0.5)).rgb;
  // A little relief, from the warped surface's own normal, so a bulge reads
  // as a bulge. It darkens by at most uShade and never changes the hue.
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  float lit = abs(dot(n, normalize(vec3(0.35, -0.45, 0.82))));
  fragColor = vec4(c * (1.0 - uShade * (1.0 - lit)), uOpacity);
}`;

export interface Scale { lo: number; hi: number; log: boolean; map: MapName; }

const FILL = 0.92;           // of the view, taken by the model's box

export class Sheet {
  readonly mesh: Mesh;
  readonly wire: Mesh;
  readonly value: Float32Array;
  readonly disp: Float32Array;
  readonly nodes: number;
  private geo: BufferGeometry;
  private mat: ShaderMaterial;
  private wireMat: ShaderMaterial;
  private map: MapName = "viridis";

  constructor(nodes: Float32Array, triangles: Uint32Array) {
    this.nodes = nodes.length / 3;
    this.value = new Float32Array(this.nodes);
    this.disp = new Float32Array(this.nodes * 3);
    const g = this.geo = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(nodes, 3));
    const v = new BufferAttribute(this.value, 1);
    const d = new BufferAttribute(this.disp, 3);
    v.setUsage(DynamicDrawUsage);
    d.setUsage(DynamicDrawUsage);
    g.setAttribute("aValue", v);
    g.setAttribute("aDisp", d);
    g.setIndex(new BufferAttribute(triangles, 1));
    g.computeBoundingSphere();

    const uniforms = () => ({
      uWarp: { value: 0 }, uLut: { value: lutTexture("viridis") },
      uLo: { value: 0 }, uHi: { value: 1 }, uLog: { value: false },
      uShade: { value: 0.22 }, uOpacity: { value: 1 },
      uClip: { value: new Vector4(0, 0, 0, -1) },
      uWire: { value: false }, uWireColor: { value: new Color(0x222222) },
      uPlain: { value: false },
    });
    this.mat = new ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, side: DoubleSide,
      glslVersion: GLSL3, uniforms: uniforms(),
    });
    this.wireMat = new ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, side: DoubleSide,
      glslVersion: GLSL3, uniforms: uniforms(), wireframe: true,
      transparent: true, depthWrite: false,
    });
    this.wireMat.uniforms.uWire.value = true;
    this.wireMat.uniforms.uOpacity.value = 0.1;
    this.mesh = new Mesh(g, this.mat);
    this.wire = new Mesh(g, this.wireMat);
    this.wire.visible = false;
    // The bounding sphere is the unwarped one; a warped sheet must not be
    // culled by it.
    this.mesh.frustumCulled = this.wire.frustumCulled = false;
  }

  /** Call after writing `value` and `disp`. */
  touch() {
    (this.geo.getAttribute("aValue") as BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute("aDisp") as BufferAttribute).needsUpdate = true;
  }

  setScale(s: Scale) {
    const u = this.mat.uniforms;
    if (s.map !== this.map) {             // called every frame: keep the LUT
      (u.uLut.value as DataTexture).dispose();
      u.uLut.value = lutTexture(s.map);
      this.map = s.map;
    }
    u.uLo.value = s.lo; u.uHi.value = s.hi; u.uLog.value = s.log;
  }

  /** No colour: the sheet has nothing of the quantity being shown. */
  setPlain(on: boolean) { this.mat.uniforms.uPlain.value = on; }

  setWarp(f: number) {
    this.mat.uniforms.uWarp.value = f;
    this.wireMat.uniforms.uWarp.value = f;
  }

  /** Keep the part of the sheet where `n . x >= d` (rest position). */
  setClip(n: [number, number, number] | null, d = 0) {
    const v = n ? new Vector4(n[0], n[1], n[2], d) : new Vector4(0, 0, 0, -1);
    this.mat.uniforms.uClip.value = v;
    this.wireMat.uniforms.uClip.value = v.clone();
  }

  setVisible(on: boolean, elements = false) {
    this.mesh.visible = on;
    this.wire.visible = on && elements;
  }

  dispose() {
    this.geo.dispose();
    (this.mat.uniforms.uLut.value as DataTexture).dispose();
    (this.wireMat.uniforms.uLut.value as DataTexture).dispose();
    this.mat.dispose();
    this.wireMat.dispose();
  }
}

function lutTexture(name: MapName): DataTexture {
  const t = new DataTexture(lut(name), 256, 1, RGBAFormat);
  t.minFilter = t.magFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

export class SheetScene {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly sheets = new Map<string, Sheet>();
  private renderer: WebGLRenderer;
  private controls: OrbitControls;
  private overlays = new Group();
  private el: HTMLElement;
  private raf = 0;
  private extent = new Vector3(1, 1, 1);
  private w = 0;
  private h = 0;
  private dpr = 0;
  private framed = false;      // a model is in, and the visitor has not moved
  private azimuth = -1.1;
  private elevation = 0.5;
  private shift = new Vector2();

  constructor(el: HTMLElement) {
    this.el = el;
    this.scene.background = new Color(0xffffff);
    this.camera = new PerspectiveCamera(34, 1, 1, 2e4);
    // The model's vertical is +z (depth is negative z); three.js defaults to
    // +y up. OrbitControls reads this, so it is set before they are made.
    this.camera.up.set(0, 0, 1);
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false });
    el.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.scene.add(this.overlays);
    this.resize();
    // The host's box, not the window, is what the canvas fills: it changes
    // when a column wraps or a font arrives, with no window resize at all.
    // A change of pixel density (a zoom, another monitor) is a window one.
    new ResizeObserver(() => this.resize()).observe(el);
    addEventListener("resize", () => this.resize());
  }

  /** Empty the scene for another model. */
  clear() {
    for (const s of this.sheets.values()) {
      this.scene.remove(s.mesh, s.wire);
      s.dispose();
    }
    this.sheets.clear();
    for (const o of [...this.overlays.children]) {
      this.overlays.remove(o);
      (o as LineSegments).geometry.dispose();
    }
  }

  add(name: string, nodes: Float32Array, triangles: Uint32Array): Sheet {
    const s = new Sheet(nodes, triangles);
    this.sheets.set(name, s);
    this.scene.add(s.mesh, s.wire);
    return s;
  }

  /** Line segments, as `[[[x, y, z], [x, y, z]], ...]`. */
  addLines(segments: number[][][], color: number) {
    const pos: number[] = [];
    for (const [a, b] of segments) pos.push(...a, ...b);
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(pos, 3));
    this.overlays.add(new LineSegments(g, new LineBasicMaterial({ color })));
  }

  /** The box the model is cut from, drawn down to `depth` km (the walls go
   *  on for as far again; there is nothing between to look at). */
  frame(lo: number[], hi: number[], depth: number) {
    const z0 = Math.max(lo[2], -depth);
    this.extent.set(hi[0] - lo[0], hi[1] - lo[1], hi[2] - z0);
    this.addLines(boxEdges(lo[0], lo[1], z0, hi[0], hi[1], hi[2]), 0xbbbbbb);
    const c = this.controls.target;
    c.set((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (z0 + hi[2]) / 2);
    this.place(-1.1, 0.5);
    this.framed = true;
    // OrbitControls recomputes the camera only inside update(), and update()
    // runs in the loop, which starts on interaction: without this the first
    // frame is drawn with the default orientation and the canvas is blank.
    this.controls.update();
    this.render();
  }

  /** Put the camera at `azimuth` about the vertical and `elevation` above
   *  the horizon (radians), as near as keeps the whole box in frame
   *  whatever the canvas's shape. The box's own corners are projected and
   *  the distance corrected until their bounding rectangle fills `FILL` of
   *  the view; then the picture is shifted so that rectangle is centred,
   *  because in perspective a box does not project about its middle (its
   *  near edge is the larger) and would sit low with air above it. */
  place(azimuth: number, elevation: number) {
    this.azimuth = azimuth; this.elevation = elevation;
    const c = this.controls.target, e = this.extent, cam = this.camera;
    const dir = new Vector3(Math.cos(elevation) * Math.cos(azimuth),
                            Math.cos(elevation) * Math.sin(azimuth),
                            Math.sin(elevation));
    cam.aspect = (this.w || 1) / (this.h || 1);
    cam.clearViewOffset();               // measured without the shift
    const corner = new Vector3();
    const box = { cx: 0, cy: 0, reach: 1 };
    const measure = (d: number) => {
      cam.position.copy(c).addScaledVector(dir, d);
      cam.lookAt(c);
      cam.updateMatrixWorld();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) {
        corner.set(c.x + sx * e.x, c.y + sy * e.y, c.z + sz * e.z).project(cam);
        x0 = Math.min(x0, corner.x); x1 = Math.max(x1, corner.x);
        y0 = Math.min(y0, corner.y); y1 = Math.max(y1, corner.y);
      }
      box.cx = (x0 + x1) / 2; box.cy = (y0 + y1) / 2;
      box.reach = Math.max(x1 - x0, y1 - y0) / 2;
    };
    let d = e.length();
    for (let pass = 0; pass < 4; pass++) {
      measure(d);
      d *= box.reach / FILL;
    }
    measure(d);
    this.shift.set(box.cx, box.cy);
    this.applyShift();
  }

  /** Shift the picture by `shift` (in units of half the view), at the
   *  canvas's present size. */
  private applyShift() {
    const w = this.w || 1, h = this.h || 1;
    this.camera.setViewOffset(w, h, this.shift.x * w / 2, -this.shift.y * h / 2, w, h);
  }

  get target(): Vector3 { return this.controls.target; }
  get size(): Vector3 { return this.extent; }

  /** Fit the drawing buffer to the host's box. The canvas's SIZE ON THE PAGE
   *  is the stylesheet's (`.stage canvas` fills its host), never the
   *  buffer's: the buffer is the box times the pixel density, and a canvas
   *  left to its buffer's size is drawn twice too large on a 2x display,
   *  cut off on the right, and pushes what follows it down the page. */
  resize() {
    const w = Math.max(1, this.el.clientWidth);
    const h = Math.max(1, this.el.clientHeight);
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w; this.h = h; this.dpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    if (this.framed) this.place(this.azimuth, this.elevation);
    else this.applyShift();            // sets the aspect too
    this.render();
  }

  /** Damped orbit needs a loop while the pointer is down; otherwise on demand. */
  start() {
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      if (this.controls.update()) this.render();
    };
    this.controls.addEventListener("start", () => {
      this.framed = false;       // the camera is the visitor's from here on
      if (!this.raf) tick();
    });
    this.controls.addEventListener("end", () => {
      cancelAnimationFrame(this.raf); this.raf = 0; this.render();
    });
    this.render();
  }

  render() { this.renderer.render(this.scene, this.camera); }
}

function boxEdges(x0: number, y0: number, z0: number,
                  x1: number, y1: number, z1: number): number[][][] {
  const c: number[][] = [];
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) {
    c.push([x, y, z]);
  }
  return [[0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3], [2, 6], [3, 7],
          [4, 5], [4, 6], [5, 7], [6, 7]].map(([a, b]) => [c[a], c[b]]);
}
