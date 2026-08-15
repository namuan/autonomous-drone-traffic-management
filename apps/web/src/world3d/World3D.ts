/**
 * World3D — imperative Three.js scene for the immersive 3D world view.
 * Consumes the same 10 Hz snapshots as the 2D console (no new API surface),
 * interpolates drone motion between snapshots at rAF rate, and renders the
 * full sector: grid, boundary, geofences, landing sites, weather, mesh links,
 * and low-poly quadcopters with trails, routes, and state rings.
 *
 * Lifecycle: constructor(container, handlers) -> setFrame()/setSelection()/
 * requestFollow() per external state change; dispose() releases everything.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { DroneView, Snapshot, WeatherZone } from "@utm/core";
import {
  BG_HEX,
  FPV_BOOST,
  FPV_SENSITIVITY,
  ROLE_HEX,
  classifyGesture,
  clampPitch,
  damp,
  flightModeState,
  followState,
  fpvCaptureActive,
  fpvDirection,
  fpvStep,
  headingYawRad,
  interpAlpha,
  lerp3,
  releaseFollowState,
  ringsFor,
  trailFade,
  worldToScene,
  wrapYaw,
  type CamModeState,
  type FpvTelemetry,
  type SimFrame,
  type Vec3,
} from "./math.js";

export interface World3DHandlers {
  /** A drone was clicked (id) or empty space was clicked (null). */
  onSelect: (id: string | null) => void;
  /** Screen-space angle of the world "north" (+Z) marker, degrees. */
  onCompass?: (angleDeg: number) => void;
  /** WebGL context was lost. */
  onStatus?: (status: "ok" | "lost") => void;
  /** Follow camera engaged (droneId) or released (null). */
  onFollowChange?: (droneId: string | null) => void;
  /** Pointer lock acquired/released on the canvas. */
  onLockChange?: (locked: boolean) => void;
  /** FPV keys active (mode fpv + pointer locked). */
  onCaptureChange?: (captured: boolean) => void;
  /** Active camera mode. */
  onModeChange?: (mode: "fpv" | "orbit" | "follow") => void;
  /** Per-frame FPV HUD telemetry. */
  onFpvTelemetry?: (t: FpvTelemetry) => void;
}

type CameraMode = CamModeState;

const FOLLOW_DIST = 46;
const FOLLOW_HEIGHT = 26;
const IDLE_DRIFT_MS = 8000;
const BODY_RADIUS_M = 2.5;
const TRAIL_CAPACITY = 512;
const SECTOR_W = 2000;
const SECTOR_H = 1000;
/** FPV spawn point (scene coords) + look toward the sector center. */
const FPV_SPAWN = { x: 0, y: 55, z: 430 } as const;
const FPV_SPAWN_YAW = Math.PI;
const FPV_SPAWN_PITCH = -0.12;

/**
 * Cheap change-detection signature for a polyline: length + first, middle
 * and last points, so intermediate route edits with the same endpoint are
 * not missed.
 */
function sigOf(pts: { x: number; y: number; z: number }[]): string {
  if (pts.length === 0) return "0";
  const a = pts[0];
  const b = pts[Math.floor(pts.length / 2)];
  const c = pts[pts.length - 1];
  return `${pts.length}:${a.x.toFixed(1)},${a.y.toFixed(1)},${a.z.toFixed(1)}|${b.x.toFixed(1)},${b.y.toFixed(1)},${b.z.toFixed(1)}|${c.x.toFixed(1)},${c.y.toFixed(1)},${c.z.toFixed(1)}`;
}

interface PolylineBuffers {
  line: THREE.Line;
  pos: Float32Array;
  col: Float32Array | null;
}

interface DroneRig {
  id: string;
  group: THREE.Group; // positioned at the interpolated position
  body: THREE.Group; // yaw rotation only
  rotors: THREE.Group[];
  pick: THREE.Mesh;
  label: THREE.Sprite;
  detRing: THREE.LineLoop;
  stateRings: Map<string, THREE.Line>;
  ringHolder: THREE.Group;
  trail: PolylineBuffers;
  route: PolylineBuffers | null;
  trailSig: string;
  routeSig: string;
  ringSig: string;
  prevPos: { x: number; y: number; z: number } | null;
  lastDrone: DroneView;
}

interface WeatherObj {
  zone: WeatherZone;
  group: THREE.Group;
  blobs: THREE.Sprite[];
  ring: THREE.Line;
  label: THREE.Sprite;
}

export class World3D {
  static isSupported(): boolean {
    try {
      const c = document.createElement("canvas");
      return !!c.getContext("webgl2");
    } catch {
      return false;
    }
  }

  private container: HTMLElement;
  private handlers: World3DHandlers;
  private reduced: boolean;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private resizeObs: ResizeObserver;
  private raf = 0;
  private lastT = performance.now();
  private disposed = false;

  private frame: SimFrame | null = null;
  private selectedId: string | null = null;
  private mode: CameraMode;
  /** Camera mode restored when a follow-chase session ends. */
  private preferred: "fpv" | "orbit";
  private fpvLockSupported: boolean;
  private lastInteraction = performance.now();

  // FPV spectator state (scene coords).
  private fpv = {
    pos: new THREE.Vector3(FPV_SPAWN.x, FPV_SPAWN.y, FPV_SPAWN.z),
    yaw: FPV_SPAWN_YAW,
    pitch: FPV_SPAWN_PITCH,
    vel: new THREE.Vector3(),
    initialized: false,
  };
  private keys = new Set<string>();
  private locked = false;
  private suppressSelect = false;
  private lastTelemetryValue: FpvTelemetry | null = null;

  private rigs = new Map<string, DroneRig>();
  private pickTargets: THREE.Mesh[] = [];
  private weatherObjs = new Map<string, WeatherObj>();
  private staticSig = "";
  private geofenceEdges: THREE.LineSegments[] = [];

  private links: THREE.LineSegments;
  private linkPos: Float32Array;

  private gridTex: THREE.CanvasTexture | null = null;
  private sectorW = SECTOR_W;
  private sectorH = SECTOR_H;

  private labelTex = new Map<string, THREE.CanvasTexture>();

  private pointerDown: { x: number; y: number } | null = null;
  private raycaster = new THREE.Raycaster();

  constructor(
    container: HTMLElement,
    handlers: World3DHandlers,
    opts: { reducedMotion?: boolean; fpvSupported?: boolean } = {}
  ) {
    this.container = container;
    this.handlers = handlers;
    this.reduced = opts.reducedMotion ?? false;
    this.fpvLockSupported = opts.fpvSupported ?? false;
    // FPV is the default on devices that can capture the pointer.
    this.preferred = this.fpvLockSupported ? "fpv" : "orbit";
    this.mode = flightModeState(this.preferred);

    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h, false);
    this.renderer.setClearColor(BG_HEX);
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(BG_HEX);
    this.scene.fog = new THREE.Fog(BG_HEX, 700, 2900);

    this.camera = new THREE.PerspectiveCamera(55, w / h, 1, 6000);
    if (this.mode.kind === "fpv") {
      this.camera.position.set(FPV_SPAWN.x, FPV_SPAWN.y, FPV_SPAWN.z);
      this.camera.rotation.order = "YXZ";
      this.camera.rotation.y = FPV_SPAWN_YAW;
      this.camera.rotation.x = FPV_SPAWN_PITCH;
    } else {
      this.camera.position.set(0, 1500, 2050);
    }

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 30;
    this.controls.maxDistance = 4600;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.autoRotateSpeed = 0.6;
    this.controls.target.set(0, 0, 0);

    // Lights: dim cool hemisphere + warm key light.
    this.scene.add(new THREE.HemisphereLight(0x8fa3bd, 0x0b0f14, 0.55));
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.15);
    sun.position.set(1300, 1900, 700);
    this.scene.add(sun);

    this.buildSky();

    // Mesh links: one shared buffer, rewritten per snapshot.
    this.linkPos = new Float32Array(128 * 2 * 3);
    const linkGeo = new THREE.BufferGeometry();
    linkGeo.setAttribute("position", new THREE.BufferAttribute(this.linkPos, 3));
    linkGeo.setDrawRange(0, 0);
    this.links = new THREE.LineSegments(
      linkGeo,
      new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.35, depthWrite: false })
    );
    this.scene.add(this.links);

    // Input: clicks (movement <= threshold) are picks; anything else is a camera gesture.
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("dblclick", this.onDblClick);
    el.addEventListener("webglcontextlost", this.onContextLost);
    this.controls.addEventListener("start", this.onControlsStart);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onFocusLost);
    document.addEventListener("visibilitychange", this.onFocusLost);
    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    document.addEventListener("pointerlockerror", this.onPointerLockError);

    this.resizeObs = new ResizeObserver(() => {
      const cw = this.container.clientWidth;
      const ch = this.container.clientHeight;
      if (cw === 0 || ch === 0) return;
      this.camera.aspect = cw / ch;
      this.camera.updateProjectionMatrix();
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      this.renderer.setSize(cw, ch, false);
    });
    this.resizeObs.observe(container);

    this.raf = requestAnimationFrame(this.tick);
  }

  // ------------------------------------------------------------- public API

  setFrame(frame: SimFrame | null): void {
    if (frame === this.frame) return;
    this.frame = frame;
    if (!frame) return;
    const snap = frame.current;
    this.ensureStatic(snap);

    this.syncWeather(snap.weather);
    this.updateLinks(snap);

    const ids = new Set(snap.drones.map((d) => d.id));
    for (const [id, rig] of this.rigs) {
      if (!ids.has(id)) this.removeRig(rig);
    }
    const prevById = new Map<string, DroneView>();
    for (const d of frame.previous?.drones ?? []) prevById.set(d.id, d);
    for (const d of snap.drones) {
      let rig = this.rigs.get(d.id);
      if (!rig) rig = this.createRig(d);
      this.updateRig(rig, d, prevById.get(d.id) ?? null);
    }
  }

  /**
   * Central mode switch. All mode changes go through here so camera/controls
   * state, pointer lock, key capture, and handlers stay consistent.
   */
  private transition(next: CameraMode): void {
    const prev = this.mode;
    this.mode = next;
    if (next.kind === "fpv") {
      this.controls.enabled = false;
      this.controls.autoRotate = false;
      if (!this.fpv.initialized) {
        // Fixed spawn for the first FPV entry of this scene.
        this.fpv.pos.set(FPV_SPAWN.x, FPV_SPAWN.y, FPV_SPAWN.z);
        this.fpv.yaw = FPV_SPAWN_YAW;
        this.fpv.pitch = FPV_SPAWN_PITCH;
        this.fpv.initialized = true;
      } else if (prev.kind === "orbit" || prev.kind === "follow") {
        // Continuous handoff: derive the pose from the current camera.
        this.fpv.pos.copy(this.camera.position);
        const dir = this.camera.getWorldDirection(new THREE.Vector3());
        this.fpv.yaw = wrapYaw(Math.atan2(dir.x, dir.z));
        this.fpv.pitch = clampPitch(Math.asin(dir.y));
      }
      this.fpv.vel.set(0, 0, 0);
      this.camera.position.copy(this.fpv.pos);
      this.camera.rotation.order = "YXZ";
      this.camera.rotation.y = this.fpv.yaw;
      this.camera.rotation.x = this.fpv.pitch;
    } else if (next.kind === "orbit") {
      this.controls.enabled = true;
      if (prev.kind === "fpv" || prev.kind === "follow") {
        // Hand off where the FPV camera ended up.
        this.camera.position.copy(this.fpv.pos);
        const dir = fpvDirection(this.fpv.yaw, this.fpv.pitch);
        this.controls.target.set(
          this.fpv.pos.x + dir.x * 80,
          this.fpv.pos.y + dir.y * 80,
          this.fpv.pos.z + dir.z * 80
        );
        this.camera.lookAt(this.controls.target);
      }
    } else {
      // follow: normal pointer interaction is required.
      this.controls.enabled = true;
      this.controls.autoRotate = false;
      // Remember where the camera is so follow-release can resume the pose.
      this.fpv.pos.copy(this.camera.position);
      const dir = this.camera.getWorldDirection(new THREE.Vector3());
      this.fpv.yaw = wrapYaw(Math.atan2(dir.x, dir.z));
      this.fpv.pitch = clampPitch(Math.asin(dir.y));
      this.fpv.vel.set(0, 0, 0);
      this.exitPointerLock();
    }
    if (next.kind !== "fpv") this.keys.clear();
    this.handlers.onModeChange?.(next.kind);
    this.handlers.onFollowChange?.(next.kind === "follow" ? next.droneId : null);
    this.updateCapture();
  }

  /** Release a follow-chase session, returning to the preferred flight mode. */
  private exitFollow(): void {
    this.transition(releaseFollowState(this.mode, this.preferred));
  }

  setFlightMode(mode: "fpv" | "orbit"): void {
    this.preferred = mode;
    this.transition(flightModeState(mode));
  }

  setSelection(id: string | null): void {
    if (id === this.selectedId) return;
    this.selectedId = id;
    for (const rig of this.rigs.values()) this.refreshRings(rig);
    if (this.mode.kind === "follow" && this.mode.droneId !== id) {
      this.exitFollow();
    }
  }

  requestFollow(droneId: string | null): void {
    this.lastInteraction = performance.now();
    this.controls.autoRotate = false;
    this.transition(followState(this.mode, this.preferred, droneId));
  }

  isFollowing(): boolean {
    return this.mode.kind === "follow";
  }

  getCameraInfo(): { mode: "fpv" | "orbit" | "follow"; droneId: string | null } {
    return this.mode.kind === "follow"
      ? { mode: "follow", droneId: this.mode.droneId }
      : { mode: this.mode.kind, droneId: null };
  }

  /** Latest FPV telemetry (for the wrapper's minimap / HUD restores). */
  lastTelemetry(): FpvTelemetry | null {
    return this.lastTelemetryValue;
  }

  /** Pointer lock on the canvas (must be called from a user gesture). */
  requestPointerLock(): void {
    if (!this.fpvLockSupported || this.locked) return;
    const el = this.renderer.domElement;
    try {
      const res = el.requestPointerLock() as unknown as Promise<void> | undefined;
      if (res && typeof res.catch === "function") res.catch(() => this.onPointerLockError());
    } catch {
      this.onPointerLockError();
    }
  }

  exitPointerLock(): void {
    if (this.locked && document.exitPointerLock) document.exitPointerLock();
  }

  private updateCapture(): void {
    this.handlers.onCaptureChange?.(fpvCaptureActive(this.mode.kind, this.locked));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener("pointerdown", this.onPointerDown);
    el.removeEventListener("pointerup", this.onPointerUp);
    el.removeEventListener("dblclick", this.onDblClick);
    el.removeEventListener("webglcontextlost", this.onContextLost);
    this.controls.removeEventListener("start", this.onControlsStart);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onFocusLost);
    document.removeEventListener("visibilitychange", this.onFocusLost);
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    document.removeEventListener("pointerlockerror", this.onPointerLockError);
    if (this.locked) this.exitPointerLock();
    this.keys.clear();
    this.handlers.onLockChange?.(false);
    this.handlers.onCaptureChange?.(false);
    this.controls.dispose();
    // Maps included: label textures are cached (idempotent double-dispose) and
    // the grid/weather textures are per-instance, so disposing everything is safe.
    this.disposeObject(this.scene, true);
    for (const tex of this.labelTex.values()) tex.dispose();
    this.labelTex.clear();
    if (this.gridTex) this.gridTex.dispose();
    this.renderer.dispose();
    if (el.parentElement === this.container) this.container.removeChild(el);
  }

  /**
   * Dispose a subtree's geometries and materials. Sprite geometries are
   * module-shared in three.js and must never be disposed per-instance.
   * With disposeMaps, material `.map` textures are also disposed (only safe
   * for per-instance textures like weather blobs / final teardown).
   */
  private disposeObject(root: THREE.Object3D, disposeMaps = false): void {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!(obj instanceof THREE.Sprite) && mesh.geometry) mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (!mat) continue;
        if (disposeMaps) {
          const m = mat as THREE.Material & { map?: THREE.Texture | null };
          if (m.map) m.map.dispose();
        }
        mat.dispose();
      }
    });
  }

  // ------------------------------------------------------------- scene build

  private buildSky(): void {
    const N = 900;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 2400 + Math.random() * 500;
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = Math.abs(r * Math.cos(phi)); // dome above the horizon
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.scene.add(
      new THREE.Points(
        geo,
        new THREE.PointsMaterial({
          color: 0x9fb2c8,
          size: 1.6,
          sizeAttenuation: false,
          transparent: true,
          opacity: 0.55,
          fog: false,
          depthWrite: false,
        })
      )
    );
  }

  private gridTexture(): THREE.CanvasTexture {
    const cv = document.createElement("canvas");
    cv.width = 512;
    cv.height = 512;
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, 512, 512);
    ctx.strokeStyle = "rgba(148, 163, 184, 0.10)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 102.4 + 0.5, 0);
      ctx.lineTo(i * 102.4 + 0.5, 512);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i * 102.4 + 0.5);
      ctx.lineTo(512, i * 102.4 + 0.5);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(148, 163, 184, 0.20)";
    ctx.strokeRect(0.5, 0.5, 511, 511);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 2); // 512 px = 500 m
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this.gridTex = tex;
    return tex;
  }

  private makeLabelTexture(text: string, color: string): { tex: THREE.CanvasTexture; aspect: number } {
    const key = `${text}|${color}`;
    let tex = this.labelTex.get(key);
    if (!tex) {
      const cv = document.createElement("canvas");
      cv.width = 512;
      cv.height = 128;
      const ctx = cv.getContext("2d")!;
      ctx.font = "600 64px ui-monospace, SFMono-Regular, Menlo, monospace";
      const w = Math.ceil(ctx.measureText(text).width) + 32;
      ctx.clearRect(0, 0, 512, 128);
      ctx.fillStyle = color;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(text, 16, 66);
      tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.userData.aspect = w / 128;
      this.labelTex.set(key, tex);
    }
    return { tex, aspect: tex.userData.aspect as number };
  }

  private makeLabel(text: string, color: string, heightM: number): THREE.Sprite {
    const { tex, aspect } = this.makeLabelTexture(text, color);
    const sp = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, opacity: 0.92, fog: false })
    );
    sp.scale.set(heightM * aspect, heightM, 1);
    return sp;
  }

  private ensureStatic(snap: Snapshot): void {
    const sig = `${snap.sector.widthM}x${snap.sector.heightM}x${snap.sector.zMax}|${snap.geofences.map((g) => g.id).join(",")}|${snap.landingSites.map((s) => s.id).join(",")}`;
    if (sig === this.staticSig) return;
    this.sectorW = snap.sector.widthM;
    this.sectorH = snap.sector.heightM;
    // Remove previous static children (rebuilt when the sector changes),
    // disposing their GPU resources.
    const toRemove: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (o.userData.static === true) toRemove.push(o);
    });
    for (const o of toRemove) {
      this.scene.remove(o);
      this.disposeObject(o, false);
    }
    this.geofenceEdges = [];
    if (this.gridTex) {
      this.gridTex.dispose();
      this.gridTex = null;
    }

    const { widthM: W, heightM: H, zMax } = snap.sector;

    // Ground grid.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(W, H),
      new THREE.MeshBasicMaterial({ map: this.gridTexture(), transparent: true, opacity: 0.85, depthWrite: false })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.userData.static = true;
    this.scene.add(ground);

    // Sector border.
    const border = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-W / 2, 0.3, -H / 2),
        new THREE.Vector3(W / 2, 0.3, -H / 2),
        new THREE.Vector3(W / 2, 0.3, H / 2),
        new THREE.Vector3(-W / 2, 0.3, H / 2),
      ]),
      new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.4 })
    );
    border.userData.static = true;
    this.scene.add(border);

    // Boundary walls.
    const wallMat = new THREE.MeshBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.05, depthWrite: false });
    const wallEdgeMat = new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.26 });
    const wallGeos = [
      new THREE.BoxGeometry(W, zMax, 2),
      new THREE.BoxGeometry(W, zMax, 2),
      new THREE.BoxGeometry(2, zMax, H),
      new THREE.BoxGeometry(2, zMax, H),
    ];
    const wallPos = [
      new THREE.Vector3(0, zMax / 2, -H / 2),
      new THREE.Vector3(0, zMax / 2, H / 2),
      new THREE.Vector3(-W / 2, zMax / 2, 0),
      new THREE.Vector3(W / 2, zMax / 2, 0),
    ];
    for (let i = 0; i < 4; i++) {
      const wall = new THREE.Mesh(wallGeos[i], wallMat);
      wall.position.copy(wallPos[i]);
      wall.userData.static = true;
      this.scene.add(wall);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(wallGeos[i]), wallEdgeMat);
      edges.position.copy(wallPos[i]);
      edges.userData.static = true;
      this.scene.add(edges);
    }

    // Corner coordinate labels.
    for (const [sx, sy] of [
      [0, 0],
      [W, 0],
      [0, H],
      [W, H],
    ]) {
      const s = worldToScene(sx, sy, 4, W, H);
      const label = this.makeLabel(`${sx},${sy}`, "#64748b", 16);
      label.position.set(s.x, s.y, s.z);
      label.userData.static = true;
      this.scene.add(label);
    }

    // Geofences (no-fly / restricted volumes).
    for (const gf of snap.geofences) {
      const c = worldToScene(gf.rect.x + gf.rect.w / 2, gf.rect.y + gf.rect.h / 2, (gf.zMin + gf.zMax) / 2, W, H);
      const box = new THREE.BoxGeometry(gf.rect.w, gf.zMax - gf.zMin, gf.rect.h);
      const fill = new THREE.Mesh(
        box,
        new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.07, depthWrite: false })
      );
      fill.position.copy(c);
      fill.userData.static = true;
      this.scene.add(fill);
      const edgeMat = new THREE.LineBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.4, depthWrite: false });
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), edgeMat);
      edges.position.copy(c);
      edges.userData.static = true;
      this.scene.add(edges);
      this.geofenceEdges.push(edges);
      const label = this.makeLabel(`NO-FLY ${gf.name}`, "#f87171", 15);
      const lp = worldToScene(gf.rect.x + gf.rect.w / 2, gf.rect.y + gf.rect.h / 2, gf.zMax + 10, W, H);
      label.position.set(lp.x, lp.y, lp.z);
      label.userData.static = true;
      this.scene.add(label);
    }

    // Landing sites.
    for (const site of snap.landingSites) {
      const s = worldToScene(site.pos.x, site.pos.y, 0, W, H);
      const g = new THREE.Group();
      const ring = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(this.circlePts(10, 48)),
        new THREE.LineBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.6, depthWrite: false })
      );
      ring.position.set(s.x, 0.6, s.z);
      g.add(ring);
      const cyl = new THREE.Mesh(
        new THREE.CylinderGeometry(2.6, 3.2, 0.5, 24),
        new THREE.MeshStandardMaterial({ color: 0x34d399, emissive: 0x34d399, emissiveIntensity: 0.45, roughness: 0.5 })
      );
      cyl.position.set(s.x, 0.25, s.z);
      g.add(cyl);
      const label = this.makeLabel(site.name, "#34d399", 15);
      label.position.set(s.x, 12, s.z);
      g.add(label);
      g.userData.static = true;
      this.scene.add(g);
    }

    this.staticSig = sig;
  }

  private circlePts(radius: number, segments: number): THREE.Vector3[] {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
    }
    return pts;
  }

  // ------------------------------------------------------------- dynamic sync

  private syncWeather(zones: WeatherZone[]): void {
    const ids = new Set(zones.map((z) => z.id));
    for (const [id, obj] of this.weatherObjs) {
      if (!ids.has(id)) {
        this.scene.remove(obj.group);
        this.disposeObject(obj.group, true); // per-zone textures, safe to dispose
        this.weatherObjs.delete(id);
      }
    }
    for (const wz of zones) {
      let obj = this.weatherObjs.get(wz.id);
      if (!obj) obj = this.createWeather(wz);
      const pulse = 0.85 + 0.15 * Math.sin(wz.phase);
      const p = worldToScene(wz.center.x, wz.center.y, wz.center.z, this.sectorW, this.sectorH);
      obj.group.position.set(p.x, p.y, p.z);
      obj.group.scale.setScalar(Math.max(0.4, (wz.radius / 60) * (1 + 0.06 * Math.sin(wz.phase))));
      for (const b of obj.blobs) {
        (b.material as THREE.SpriteMaterial).opacity = b.userData.baseOpacity * wz.intensity * pulse;
      }
      (obj.ring.material as THREE.LineDashedMaterial).opacity = 0.5 * wz.intensity;
      const label = `TURB ${Math.round(wz.radius)}m`;
      if (obj.label.userData.text !== label) {
        obj.label.userData.text = label;
        const { tex, aspect } = this.makeLabelTexture(label, "#facc15");
        const mat = obj.label.material as THREE.SpriteMaterial;
        mat.map = tex;
        mat.needsUpdate = true;
        obj.label.scale.set(15 * aspect, 15, 1);
      }
      obj.zone = wz;
    }
  }

  private createWeather(wz: WeatherZone): WeatherObj {
    const group = new THREE.Group();
    const tex = this.weatherTexture();
    const blobs: THREE.Sprite[] = [];
    const layers: { scale: number; opacity: number }[] = [
      { scale: 1.0, opacity: 0.3 },
      { scale: 0.72, opacity: 0.22 },
      { scale: 0.48, opacity: 0.14 },
    ];
    for (const l of layers) {
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: l.opacity })
      );
      sp.userData.baseOpacity = l.opacity;
      sp.scale.setScalar(120 * l.scale);
      group.add(sp);
      blobs.push(sp);
    }
    const ring = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(this.circlePts(60, 64)),
      new THREE.LineDashedMaterial({ color: 0xfacc15, dashSize: 10, gapSize: 8, transparent: true, opacity: 0.5, depthWrite: false })
    );
    ring.position.y = 0.8;
    ring.computeLineDistances();
    group.add(ring);
    const label = this.makeLabel(`TURB ${Math.round(wz.radius)}m`, "#facc15", 15);
    label.userData.text = "";
    label.position.y = 80;
    group.add(label);
    this.scene.add(group);
    const obj: WeatherObj = { zone: wz, group, blobs, ring, label };
    this.weatherObjs.set(wz.id, obj);
    return obj;
  }

  private weatherTexture(): THREE.CanvasTexture {
    const cv = document.createElement("canvas");
    cv.width = 256;
    cv.height = 256;
    const ctx = cv.getContext("2d")!;
    const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
    g.addColorStop(0, "rgba(250, 204, 21, 0.6)");
    g.addColorStop(0.55, "rgba(250, 204, 21, 0.18)");
    g.addColorStop(1, "rgba(250, 204, 21, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private updateLinks(snap: Snapshot): void {
    const byId = new Map(snap.drones.map((d) => [d.id, d]));
    let k = 0;
    for (const link of snap.meshLinks) {
      if (k >= 128) break;
      const a = byId.get(link.a);
      const b = byId.get(link.b);
      if (!a || !b) continue;
      const pa = worldToScene(a.x, a.y, a.z, this.sectorW, this.sectorH);
      const pb = worldToScene(b.x, b.y, b.z, this.sectorW, this.sectorH);
      this.linkPos[k * 6] = pa.x;
      this.linkPos[k * 6 + 1] = pa.y;
      this.linkPos[k * 6 + 2] = pa.z;
      this.linkPos[k * 6 + 3] = pb.x;
      this.linkPos[k * 6 + 4] = pb.y;
      this.linkPos[k * 6 + 5] = pb.z;
      k++;
    }
    const geo = this.links.geometry as THREE.BufferGeometry;
    geo.setDrawRange(0, k * 2);
    geo.attributes.position.needsUpdate = true;
  }

  // ------------------------------------------------------------- drones

  private createRig(d: DroneView): DroneRig {
    const group = new THREE.Group();
    const body = new THREE.Group();
    const color = new THREE.Color(ROLE_HEX[d.role]);
    const bodyMat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.32,
      metalness: 0.35,
      roughness: 0.55,
    });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.7 });

    // Fuselage (nose points +X).
    const fuselage = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.5, 1.3), bodyMat);
    fuselage.position.y = 0.15;
    body.add(fuselage);

    // Nose cone.
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.0, 4), bodyMat);
    nose.rotation.z = -Math.PI / 2;
    nose.position.set(1.65, 0.18, 0);
    body.add(nose);

    // Rotor arms + rotors.
    const rotors: THREE.Group[] = [];
    const armLen = 2.1;
    const rotorPos: [number, number][] = [
      [1.65, 1.45],
      [1.65, -1.45],
      [-1.65, 1.45],
      [-1.65, -1.45],
    ];
    for (const [rx, rz] of rotorPos) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(armLen, 0.09, 0.34), darkMat);
      const ang = Math.atan2(rz, rx);
      arm.position.set(Math.cos(ang) * armLen * 0.5, 0.05, Math.sin(ang) * armLen * 0.5);
      arm.rotation.y = ang + Math.PI / 2;
      body.add(arm);
      const rotor = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.05, 18), darkMat);
      disc.rotation.x = Math.PI / 2;
      rotor.add(disc);
      rotor.position.set(rx, 0.32, rz);
      body.add(rotor);
      rotors.push(rotor);
    }

    // Pick target (invisible hit sphere for raycasting).
    const pick = new THREE.Mesh(
      new THREE.SphereGeometry(7, 10, 8),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
    );
    pick.userData.droneId = d.id;
    pick.position.y = 2;
    group.add(pick);

    // Callsign label.
    const label = this.makeLabel(d.callsign, d.role === "delivery" ? "#7dd3fc" : "#d8b4fe", 17);
    label.position.y = 8.5;
    group.add(label);

    // Detection ring (18 m) + state rings live on the ground, follow the drone.
    const detRing = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(this.circlePts(18, 64)),
      new THREE.LineBasicMaterial({ color: ROLE_HEX[d.role], transparent: true, opacity: 0.4, depthWrite: false })
    );
    detRing.position.y = 0.6;
    group.add(detRing);

    const ringHolder = new THREE.Group();
    ringHolder.position.y = 0.6;
    group.add(ringHolder);

    // Trails and routes live in world space (not attached to the moving group).
    const trail = this.makePolyline(true);
    const route = this.makePolyline(false);

    group.add(body);
    this.scene.add(group);

    const rig: DroneRig = {
      id: d.id,
      group,
      body,
      rotors,
      pick,
      label,
      detRing,
      stateRings: new Map(),
      ringHolder,
      trail,
      route,
      trailSig: "",
      routeSig: "",
      ringSig: "",
      prevPos: null,
      lastDrone: d,
    };
    this.rigs.set(d.id, rig);
    this.pickTargets.push(pick);
    return rig;
  }

  private makePolyline(withColor: boolean): PolylineBuffers {
    const pos = new Float32Array(TRAIL_CAPACITY * 3);
    const col = withColor ? new Float32Array(TRAIL_CAPACITY * 3) : null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    if (col) geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setDrawRange(0, 0);
    const mat = withColor
      ? new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 })
      : new THREE.LineDashedMaterial({ color: 0x94a3b8, dashSize: 12, gapSize: 9, transparent: true, opacity: 0.42, depthWrite: false });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    return { line, pos, col };
  }

  private updateRig(rig: DroneRig, d: DroneView, prev: DroneView | null): void {
    rig.prevPos = prev ? worldToScene(prev.x, prev.y, prev.z, this.sectorW, this.sectorH) : null;
    rig.lastDrone = d;

    // Trail (server-provided; rebuilt only when it changes).
    const trail = d.trail;
    const trailSig = sigOf(trail);
    if (trailSig !== rig.trailSig) {
      rig.trailSig = trailSig;
      const n = Math.min(trail.length, TRAIL_CAPACITY);
      for (let i = 0; i < n; i++) {
        const p = worldToScene(trail[i].x, trail[i].y, trail[i].z, this.sectorW, this.sectorH);
        rig.trail.pos[i * 3] = p.x;
        rig.trail.pos[i * 3 + 1] = p.y;
        rig.trail.pos[i * 3 + 2] = p.z;
        if (rig.trail.col) {
          const c = trailFade(d.role, n > 1 ? i / (n - 1) : 1);
          rig.trail.col[i * 3] = c.r;
          rig.trail.col[i * 3 + 1] = c.g;
          rig.trail.col[i * 3 + 2] = c.b;
        }
      }
      const geo = rig.trail.line.geometry as THREE.BufferGeometry;
      geo.setDrawRange(0, n);
      (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      if (geo.attributes.color) (geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    }

    // Planned route.
    const route = d.route;
    const routeSig = sigOf(route);
    if (routeSig !== rig.routeSig) {
      rig.routeSig = routeSig;
      if (!rig.route && route.length > 1) rig.route = this.makePolyline(false);
      if (rig.route) {
        const n = Math.min(route.length, TRAIL_CAPACITY);
        for (let i = 0; i < n; i++) {
          const p = worldToScene(route[i].x, route[i].y, route[i].z, this.sectorW, this.sectorH);
          rig.route.pos[i * 3] = p.x;
          rig.route.pos[i * 3 + 1] = p.y;
          rig.route.pos[i * 3 + 2] = p.z;
        }
        const geo = rig.route.line.geometry as THREE.BufferGeometry;
        geo.setDrawRange(0, n);
        (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        rig.route.line.computeLineDistances();
      }
    }

    this.refreshRings(rig);
  }

  private refreshRings(rig: DroneRig): void {
    const rings = ringsFor(rig.lastDrone, rig.lastDrone.id === this.selectedId);
    const sig = rings.map((r) => r.kind).join("|");
    if (sig === rig.ringSig) return;
    rig.ringSig = sig;
    for (const ring of rig.stateRings.values()) {
      rig.ringHolder.remove(ring);
      this.disposeObject(ring, false);
    }
    rig.stateRings.clear();
    const seen = new Set<string>();
    for (const spec of rings) {
      if (seen.has(spec.kind)) continue;
      seen.add(spec.kind);
      const radius = BODY_RADIUS_M + spec.radiusOffsetM;
      const pts = this.circlePts(radius, 40);
      pts.push(pts[0].clone()); // close the loop so dashed lines wrap
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = spec.dashed
        ? new THREE.LineDashedMaterial({ color: spec.color, dashSize: 3, gapSize: 2.4, transparent: true, opacity: 0.9, depthWrite: false })
        : new THREE.LineBasicMaterial({ color: spec.color, transparent: true, opacity: 0.9, depthWrite: false });
      const line = new THREE.Line(geo, mat);
      if (spec.dashed) line.computeLineDistances();
      rig.ringHolder.add(line);
      rig.stateRings.set(spec.kind, line);
    }
  }

  private removeRig(rig: DroneRig): void {
    this.rigs.delete(rig.id);
    const idx = this.pickTargets.indexOf(rig.pick);
    if (idx >= 0) this.pickTargets.splice(idx, 1);
    this.scene.remove(rig.group);
    this.scene.remove(rig.trail.line);
    if (rig.route) this.scene.remove(rig.route.line);
    this.disposeObject(rig.group, false);
    this.disposeObject(rig.trail.line, false);
    if (rig.route) this.disposeObject(rig.route.line, false);
  }

  // ------------------------------------------------------------- input

  private static readonly FPV_KEYS = new Set(["w", "a", "s", "d", "x", " ", "shift"]);

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    if (this.mode.kind === "fpv" && !this.locked && this.fpvLockSupported) {
      this.requestPointerLock();
      this.suppressSelect = true; // the lock-acquiring click must not select
    }
    this.pointerDown = { x: e.clientX, y: e.clientY };
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.pointerDown) return;
    const dx = e.clientX - this.pointerDown.x;
    const dy = e.clientY - this.pointerDown.y;
    this.pointerDown = null;
    if (this.suppressSelect) {
      this.suppressSelect = false;
      return;
    }
    if (classifyGesture(Math.hypot(dx, dy)) !== "click") return;
    const hit = this.pickAt(e.clientX, e.clientY);
    this.handlers.onSelect(hit ? (hit.userData.droneId as string) : null);
  };

  private onDblClick = (e: MouseEvent): void => {
    const hit = this.pickAt(e.clientX, e.clientY);
    if (hit) {
      const id = hit.userData.droneId as string;
      this.handlers.onSelect(id);
      this.requestFollow(id);
    } else if (this.mode.kind === "follow") {
      this.requestFollow(null); // release follow, keep selection
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!fpvCaptureActive(this.mode.kind, this.locked)) return;
    const k = e.key.toLowerCase();
    if (World3D.FPV_KEYS.has(k)) {
      e.preventDefault();
      this.keys.add(k);
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  private onFocusLost = (): void => {
    this.keys.clear();
    this.fpv.vel.set(0, 0, 0);
    this.pointerDown = null;
    this.suppressSelect = false;
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!fpvCaptureActive(this.mode.kind, this.locked)) return;
    this.fpv.yaw = wrapYaw(this.fpv.yaw + e.movementX * FPV_SENSITIVITY);
    this.fpv.pitch = clampPitch(this.fpv.pitch - e.movementY * FPV_SENSITIVITY);
  };

  private onPointerLockChange = (): void => {
    const was = this.locked;
    this.locked = document.pointerLockElement === this.renderer.domElement;
    if (this.locked !== was) {
      if (!this.locked) this.onFocusLost();
      this.handlers.onLockChange?.(this.locked);
      this.updateCapture();
    }
  };

  private onPointerLockError = (): void => {
    if (!this.locked) return;
    this.locked = false;
    this.onFocusLost();
    this.handlers.onLockChange?.(false);
    this.updateCapture();
  };

  private onControlsStart = (): void => {
    this.lastInteraction = performance.now();
    this.controls.autoRotate = false;
    if (this.mode.kind === "follow") this.exitFollow();
  };

  private onContextLost = (e: Event): void => {
    e.preventDefault();
    this.handlers.onStatus?.("lost");
  };

  private pickAt(clientX: number, clientY: number): THREE.Mesh | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickTargets, false);
    for (const h of hits) {
      if (h.object.userData.droneId) return h.object as THREE.Mesh;
    }
    return null;
  }

  // ------------------------------------------------------------- frame loop

  private updateCamera(now: number, dtMs: number, alpha: number): void {
    if (this.mode.kind === "follow") {
      const rig = this.mode.kind === "follow" ? this.rigs.get(this.mode.droneId ?? "") : null;
      if (!rig) {
        this.exitFollow();
        return;
      }
      const d = rig.lastDrone;
      const cur = worldToScene(d.x, d.y, d.z, this.sectorW, this.sectorH);
      const interp = rig.prevPos ? lerp3(rig.prevPos, cur, alpha) : cur;
      const yaw = headingYawRad(d.headingDeg);
      const noseX = Math.cos(yaw);
      const noseZ = -Math.sin(yaw);
      const target = new THREE.Vector3(interp.x, interp.y + 5, interp.z);
      const desired = new THREE.Vector3(
        interp.x - noseX * FOLLOW_DIST,
        interp.y + FOLLOW_HEIGHT,
        interp.z - noseZ * FOLLOW_DIST
      );
      this.camera.position.set(
        damp(this.camera.position.x, desired.x, 3.2, dtMs),
        damp(this.camera.position.y, desired.y, 3.2, dtMs),
        damp(this.camera.position.z, desired.z, 3.2, dtMs)
      );
      this.controls.target.set(
        damp(this.controls.target.x, target.x, 4, dtMs),
        damp(this.controls.target.y, target.y, 4, dtMs),
        damp(this.controls.target.z, target.z, 4, dtMs)
      );
    } else if (this.mode.kind === "orbit" && !this.reduced && now - this.lastInteraction > IDLE_DRIFT_MS) {
      this.controls.autoRotate = true;
    }
  }

  private vec3ToPlain(v: THREE.Vector3): Vec3 {
    return { x: v.x, y: v.y, z: v.z };
  }

  private updateFpv(dtMs: number): void {
    const captured = fpvCaptureActive(this.mode.kind, this.locked);
    if (captured) {
      const zMax = this.frame?.current.sector.zMax ?? 150;
      const input = {
        fwd: (this.keys.has("w") ? 1 : 0) - (this.keys.has("s") ? 1 : 0),
        strafe: (this.keys.has("d") ? 1 : 0) - (this.keys.has("a") ? 1 : 0),
        up: (this.keys.has(" ") ? 1 : 0) - (this.keys.has("x") ? 1 : 0),
        boost: this.keys.has("shift") ? FPV_BOOST : 1,
      };
      const res = fpvStep(
        { pos: this.vec3ToPlain(this.fpv.pos), vel: this.vec3ToPlain(this.fpv.vel) },
        input,
        this.fpv.yaw,
        this.fpv.pitch,
        dtMs,
        this.sectorW,
        this.sectorH,
        zMax
      );
      this.fpv.pos.set(res.pos.x, res.pos.y, res.pos.z);
      this.fpv.vel.set(res.vel.x, res.vel.y, res.vel.z);
    }
    this.camera.position.copy(this.fpv.pos);
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = this.fpv.yaw;
    this.camera.rotation.x = this.fpv.pitch;

    // HUD telemetry (sector-frame position).
    if (this.handlers.onFpvTelemetry) {
      let inWeather = false;
      let weatherDepth = 0;
      for (const wz of this.frame?.current.weather ?? []) {
        const cx = wz.center.x - this.sectorW / 2;
        const cz = wz.center.z - this.sectorH / 2;
        const dist = Math.hypot(this.fpv.pos.x - cx, this.fpv.pos.y - wz.center.y, this.fpv.pos.z - cz);
        if (dist < wz.radius) {
          inWeather = true;
          weatherDepth = Math.max(weatherDepth, 1 - dist / wz.radius);
        }
      }
      const headingDeg = ((wrapYaw(this.fpv.yaw) * 180) / Math.PI + 360) % 360;
      this.lastTelemetryValue = {
        x: this.fpv.pos.x + this.sectorW / 2,
        y: this.fpv.pos.z + this.sectorH / 2,
        z: this.fpv.pos.y,
        headingDeg,
        pitchDeg: (this.fpv.pitch * 180) / Math.PI,
        speedMps: this.fpv.vel.length(),
        inWeather,
        weatherDepth,
        locked: this.locked,
      };
      this.handlers.onFpvTelemetry(this.lastTelemetryValue);
    }
  }

  private tick = (): void => {
    if (this.disposed) return;
    const now = performance.now();
    const dtMs = Math.min(100, now - this.lastT);
    this.lastT = now;

    const frame = this.frame;
    const paused = frame?.current.paused ?? true;
    const alpha = interpAlpha(frame, now, paused, this.reduced);

    if (this.mode.kind === "fpv") {
      this.updateFpv(dtMs);
    } else {
      this.updateCamera(now, dtMs, alpha);
    }

    for (const rig of this.rigs.values()) {
      const d = rig.lastDrone;
      const cur = worldToScene(d.x, d.y, d.z, this.sectorW, this.sectorH);
      const interp = rig.prevPos ? lerp3(rig.prevPos, cur, alpha) : cur;
      rig.group.position.set(interp.x, interp.y, interp.z);
      rig.body.rotation.y = headingYawRad(d.headingDeg);
      if (!paused && !this.reduced && d.state !== "landed" && d.state !== "removed") {
        const spin = (dtMs / 1000) * (d.state === "waiting" || d.state === "requesting" ? 8 : 42);
        for (const r of rig.rotors) r.rotation.y += spin;
      }
    }

    // Geofence edge pulse.
    const pulse = 0.36 + 0.1 * Math.sin(now / 1800);
    for (const e of this.geofenceEdges) {
      (e.material as THREE.LineBasicMaterial).opacity = pulse;
    }

    // Compass: screen angle of world north (+Z), measured from points ahead of
    // the camera so the projection never flips behind the view.
    if (this.handlers.onCompass) {
      const viewDir = this.camera.getWorldDirection(new THREE.Vector3());
      const base = this.camera.position.clone().addScaledVector(viewDir, 600);
      const north = base.clone().add(new THREE.Vector3(0, 0, 120));
      const pb = base.project(this.camera);
      const pn = north.project(this.camera);
      const wpx = this.renderer.domElement.clientWidth;
      const hpx = this.renderer.domElement.clientHeight;
      const dx = (pn.x - pb.x) * wpx;
      const dy = (pn.y - pb.y) * hpx;
      this.handlers.onCompass((Math.atan2(dx, -dy) * 180) / Math.PI);
    }

    // OrbitControls.update() calls camera.lookAt() unconditionally (it does
    // not check `enabled`), so it must never run while FPV owns the camera.
    if (this.mode.kind !== "fpv") this.controls.update();

    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.tick);
  };
}
