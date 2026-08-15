/**
 * Pure helpers for the 3D world view. No three.js imports here — everything
 * is unit-testable in isolation.
 *
 * Coordinate convention (single conversion, used everywhere):
 *   scene X = sector x - width/2   (east)
 *   scene Y = altitude z           (up)
 *   scene Z = sector y - height/2  (north)
 */

import type { DroneRole, DroneView, Snapshot } from "@utm/core";

/** A snapshot plus the previous snapshot it is transitioning from. */
export interface SimFrame {
  current: Snapshot;
  previous: Snapshot | null;
  /** performance.now() when `current` was received. */
  receivedAtMs: number;
}

/** One server tick at 10 Hz; interpolation eases over a single tick. */
export const TICK_MS = 100;

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const lerp = (a: number, b: number, t: number): number => {
  if (t <= 0) return a;
  if (t >= 1) return b;
  return a + (b - a) * t;
};

/** Frame-rate-independent exponential damping (kensho-style smoothing). */
export const damp = (current: number, target: number, lambda: number, dtMs: number): number =>
  lerp(current, target, 1 - Math.exp(-lambda * (dtMs / 1000)));

/** Sector meters -> scene units. */
export function worldToScene(
  x: number,
  y: number,
  z: number,
  sectorWidthM: number,
  sectorHeightM: number
): { x: number; y: number; z: number } {
  return { x: x - sectorWidthM / 2, y: z, z: y - sectorHeightM / 2 };
}

/** Scene units -> sector meters. */
export function sceneToWorld(
  sx: number,
  sy: number,
  sz: number,
  sectorWidthM: number,
  sectorHeightM: number
): { x: number; y: number; z: number } {
  return { x: sx + sectorWidthM / 2, y: sz + sectorHeightM / 2, z: sy };
}

/** Role accent colors, matching the 2D console palette. */
export const ROLE_HEX: Record<DroneRole, number> = { delivery: 0x38bdf8, surveillance: 0xc084fc };
export const ROLE_HEX_STR: Record<DroneRole, string> = { delivery: "#38bdf8", surveillance: "#c084fc" };

export interface Rgb01 {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: number): Rgb01 {
  return { r: ((hex >> 16) & 0xff) / 255, g: ((hex >> 8) & 0xff) / 255, b: (hex & 0xff) / 255 };
}

/** Console background — trail segments fade toward this color (LineBasicMaterial has no per-vertex alpha). */
export const BG_HEX = 0x0b0f14;

/** Fade fraction `frac` (0 = oldest point, 1 = newest) toward the background. */
export function trailFade(role: DroneRole, frac: number): Rgb01 {
  const c = hexToRgb(ROLE_HEX[role]);
  const bg = hexToRgb(BG_HEX);
  const t = Math.pow(clamp01(frac), 1.5);
  return { r: lerp(bg.r, c.r, t), g: lerp(bg.g, c.g, t), b: lerp(bg.b, c.b, t) };
}

export interface RingSpec {
  kind: "selected" | "critical" | "untrusted" | "lost" | "reroute";
  color: number;
  dashed: boolean;
  /** Ring radius = body radius (2.5 m) + offset. */
  radiusOffsetM: number;
}

/** State rings mirroring the 2D console color language; multiple rings can stack. */
export function ringsFor(d: DroneView, selected: boolean): RingSpec[] {
  const rings: RingSpec[] = [];
  if (selected) rings.push({ kind: "selected", color: 0xf8fafc, dashed: false, radiusOffsetM: 5 });
  if (d.flags.criticalBattery) rings.push({ kind: "critical", color: 0xf87171, dashed: false, radiusOffsetM: 3 });
  if (d.flags.untrusted) rings.push({ kind: "untrusted", color: 0xfb923c, dashed: true, radiusOffsetM: 6 });
  if (d.flags.lostLink) rings.push({ kind: "lost", color: 0x9ca3af, dashed: false, radiusOffsetM: 9 });
  if (d.state === "rerouting") rings.push({ kind: "reroute", color: 0xfde047, dashed: false, radiusOffsetM: 8 });
  return rings;
}

/** Interpolation alpha for snapshot-to-snapshot blending over one tick. */
export function interpAlpha(frame: SimFrame | null, nowMs: number, paused: boolean, reducedMotion: boolean): number {
  if (!frame || frame.previous === null || paused || reducedMotion) return 1;
  const dt = nowMs - frame.receivedAtMs;
  if (dt <= 0) return 0; // just arrived: still at the previous position
  return clamp01(dt / TICK_MS);
}

export function lerp3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, t: number): { x: number; y: number; z: number } {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) };
}

/** Interpolated scene position for one drone (snaps when no previous observation). */
export function droneScenePos(d: DroneView, prev: DroneView | null, alpha: number, sectorWidthM: number, sectorHeightM: number): { x: number; y: number; z: number } {
  const cur = worldToScene(d.x, d.y, d.z, sectorWidthM, sectorHeightM);
  if (!prev || alpha >= 1) return cur;
  const old = worldToScene(prev.x, prev.y, prev.z, sectorWidthM, sectorHeightM);
  return lerp3(old, cur, clamp01(alpha));
}

/** Sim heading (deg, 0 = +x sector axis) -> scene yaw for a nose pointing +X. */
export const headingYawRad = (headingDeg: number): number => (-headingDeg * Math.PI) / 180;

// ---------------------------------------------------------------------------
// FPV (first-person) spectator flight — pure movement math
//
// Conventions: yaw 0 = +Z (north), positive yaw turns toward +X (east);
// pitch positive = up. Forward = (sin y, cos y * sin p, cos y * cos p).
// ---------------------------------------------------------------------------

export const FPV_BASE_SPEED = 55; // m/s
/** Extra speed multiplier while holding Shift. */
export const FPV_BOOST = 2.2;
/** Velocity smoothing lambda (higher = snappier). */
export const FPV_LAMBDA = 4;
/** Max |pitch| in radians. */
export const FPV_PITCH_LIMIT = 1.35;
/** Pointer-look sensitivity (radians per pixel). */
export const FPV_SENSITIVITY = 0.0022;
/** Distance kept from the sector footprint edge. */
export const FPV_CLAMP_MARGIN = 8;
/** Max altitude above the sector ceiling. */
export const FPV_CLAMP_ALT = 120;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Normalized look direction from yaw/pitch. */
export function fpvDirection(yawRad: number, pitchRad: number): Vec3 {
  const cp = Math.cos(pitchRad);
  return { x: Math.sin(yawRad) * cp, y: Math.sin(pitchRad), z: Math.cos(yawRad) * cp };
}

/** Horizontal right vector for strafing. */
export function fpvRight(yawRad: number): Vec3 {
  return { x: Math.cos(yawRad), y: 0, z: -Math.sin(yawRad) };
}

export const wrapYaw = (yawRad: number): number => {
  const twoPi = Math.PI * 2;
  return (((yawRad + Math.PI) % twoPi) + twoPi) % twoPi - Math.PI;
};

export const clampPitch = (pitchRad: number): number =>
  Math.max(-FPV_PITCH_LIMIT, Math.min(FPV_PITCH_LIMIT, pitchRad));

export interface FpvInput {
  /** -1..1 (S..W). */
  fwd: number;
  /** -1..1 (A..D). */
  strafe: number;
  /** -1..1 (X..Space). */
  up: number;
  /** 1 = normal, >1 = boosted. */
  boost: number;
}

export interface FpvPose {
  pos: Vec3;
  vel: Vec3;
}

/**
 * One FPV integration step. Input intent is normalized so diagonals do not
 * move faster than straight lines; velocity is exponentially damped toward
 * the target; the position is clamped to the sector and clamped velocity
 * components are zeroed. Returns a new pose.
 */
export function fpvStep(
  pose: FpvPose,
  input: FpvInput,
  yawRad: number,
  pitchRad: number,
  dtMs: number,
  sectorWidthM: number,
  sectorHeightM: number,
  zMax: number,
  opts: { baseSpeed?: number; boost?: number; lambda?: number } = {}
): FpvPose {
  const baseSpeed = opts.baseSpeed ?? FPV_BASE_SPEED;
  const boost = opts.boost ?? FPV_BOOST;
  const lambda = opts.lambda ?? FPV_LAMBDA;
  const dtSec = Math.min(0.25, Math.max(0, dtMs) / 1000); // cap long frames

  const fwd = fpvDirection(yawRad, pitchRad);
  const right = fpvRight(yawRad);
  let ix = fwd.x * input.fwd + right.x * input.strafe;
  let iy = fwd.y * input.fwd + input.up;
  let iz = fwd.z * input.fwd + right.z * input.strafe;
  const ilen = Math.hypot(ix, iy, iz);
  if (ilen > 0) {
    ix /= ilen;
    iy /= ilen;
    iz /= ilen;
  }

  const speed = baseSpeed * (input.boost > 1 ? boost : 1);
  const alpha = 1 - Math.exp(-lambda * dtSec);
  const vel = {
    x: pose.vel.x + (ix * speed - pose.vel.x) * alpha,
    y: pose.vel.y + (iy * speed - pose.vel.y) * alpha,
    z: pose.vel.z + (iz * speed - pose.vel.z) * alpha,
  };

  let pos = {
    x: pose.pos.x + vel.x * dtSec,
    y: pose.pos.y + vel.y * dtSec,
    z: pose.pos.z + vel.z * dtSec,
  };

  // Clamp to the sector footprint (with margin) and above/below the
  // airspace envelope; zero the velocity component on a clamped axis.
  const minX = -sectorWidthM / 2 + FPV_CLAMP_MARGIN;
  const maxX = sectorWidthM / 2 - FPV_CLAMP_MARGIN;
  const minZ = -sectorHeightM / 2 + FPV_CLAMP_MARGIN;
  const maxZ = sectorHeightM / 2 - FPV_CLAMP_MARGIN;
  const minY = 1.5;
  const maxY = zMax + FPV_CLAMP_ALT;
  const clampAxis = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const px = clampAxis(pos.x, minX, maxX);
  if (px !== pos.x) vel.x = 0;
  const py = clampAxis(pos.y, minY, maxY);
  if (py !== pos.y) vel.y = 0;
  const pz = clampAxis(pos.z, minZ, maxZ);
  if (pz !== pos.z) vel.z = 0;
  pos = { x: px, y: py, z: pz };

  return { pos, vel };
}

/** FPV keys only act while the camera is captured (pointer-locked). */
export function fpvCaptureActive(mode: "fpv" | "orbit" | "follow", locked: boolean): boolean {
  return mode === "fpv" && locked;
}

// ---------------------------------------------------------------------------
// Camera-mode state machine (pure — World3D applies side effects around it)
// ---------------------------------------------------------------------------

export type CamModeKind = "fpv" | "orbit" | "follow";

export interface CamModeState {
  kind: CamModeKind;
  /** Follow target, when kind === "follow". */
  droneId: string | null;
}

/** User picked a flight mode (never "follow"). */
export function flightModeState(mode: "fpv" | "orbit"): CamModeState {
  return { kind: mode, droneId: null };
}

/** Engage or release a follow-chase session; release returns to `preferred`. */
export function followState(current: CamModeState, preferred: "fpv" | "orbit", droneId: string | null): CamModeState {
  if (!droneId) return { kind: preferred, droneId: null };
  if (current.kind === "follow" && current.droneId === droneId) return current;
  return { kind: "follow", droneId };
}

/** Single release path for every follow-exit trigger. */
export function releaseFollowState(current: CamModeState, preferred: "fpv" | "orbit"): CamModeState {
  if (current.kind !== "follow") return current;
  return { kind: preferred, droneId: null };
}

/** Per-frame FPV HUD telemetry (sector-frame x/y, altitude z). */
export interface FpvTelemetry {
  x: number;
  y: number;
  z: number;
  headingDeg: number;
  pitchDeg: number;
  speedMps: number;
  /** Inside a weather cell? */
  inWeather: boolean;
  /** 0..1 depth inside the cell (drives the HUD tint). */
  weatherDepth: number;
  locked: boolean;
}

/** Compass/marker rotation: minimap north (+Z, sector +y) is screen-down; a
 * positive heading turns the marker toward the screen-right (east). */
export const cameraMarkerRotation = (headingDeg: number): number =>
  wrapYaw(((180 - headingDeg) * Math.PI) / 180);

/** Click-vs-drag disambiguation: pointer movement above the threshold is a camera gesture. */
export const DRAG_THRESHOLD_PX = 5;
export const classifyGesture = (movementPx: number): "click" | "drag" =>
  movementPx <= DRAG_THRESHOLD_PX ? "click" : "drag";

export function sectorCenter(snap: Snapshot): { x: number; y: number; z: number } {
  return { x: 0, y: snap.sector.zMax / 2, z: 0 };
}
