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

/** Click-vs-drag disambiguation: pointer movement above the threshold is a camera gesture. */
export const DRAG_THRESHOLD_PX = 5;
export const classifyGesture = (movementPx: number): "click" | "drag" =>
  movementPx <= DRAG_THRESHOLD_PX ? "click" : "drag";

export function sectorCenter(snap: Snapshot): { x: number; y: number; z: number } {
  return { x: 0, y: snap.sector.zMax / 2, z: 0 };
}
