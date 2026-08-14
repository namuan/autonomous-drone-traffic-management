/**
 * 4D trajectory contracts: time-sampled (x, y, z, t) tubes with horizontal and
 * vertical tolerances. Strategic deconfliction happens at planning time: a new
 * contract is only issued if it does not conflict with existing reservations.
 */

import { CONFIG } from "@utm/core";
import type { Point3, TrajectoryContract, TrajectoryPoint } from "@utm/core";
import { dist2 } from "@utm/core";

export interface BuildContractOptions {
  speedMps: number;
  t0: number; // sim seconds
  hToleranceM?: number;
  vToleranceM?: number;
  sampleS?: number;
}

/**
 * Build a descent/lane profile onto a 2D path: z interpolates from startZ at
 * the beginning to endZ at the last waypoint, so contracts carry a vertical
 * profile the MPC can follow.
 */
export function withVerticalProfile(path: Point3[], startZ: number, endZ: number): Point3[] {
  const n = path.length;
  if (n === 0) return path;
  return path.map((p, i) => ({ ...p, z: startZ + ((endZ - startZ) * i) / (n - 1) }));
}

/** Resample a polyline path into a time-stamped trajectory at constant speed. */
export function buildContract(
  droneId: string,
  path: Point3[],
  opts: BuildContractOptions
): TrajectoryContract {
  const sampleS = opts.sampleS ?? CONFIG.planning.contractSampleS;
  const hTolerance = opts.hToleranceM ?? 25;
  const vTolerance = opts.vToleranceM ?? 10;
  const speed = Math.max(1, opts.speedMps);
  const t0 = opts.t0;

  // Cumulative distance along the path.
  const cum: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point3;
    const b = path[i] as Point3;
    cum.push((cum[i - 1] as number) + dist2(a.x, a.y, b.x, b.y));
  }
  const total = cum[cum.length - 1] as number;
  const endT = t0 + total / speed;

  const positionAt = (t: number): Point3 => {
    const s = (t - t0) * speed;
    if (s >= total) return { ...(path[path.length - 1] as Point3) };
    let lo = 0;
    let hi = path.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if ((cum[mid] as number) <= s) lo = mid;
      else hi = mid;
    }
    const segLen = (cum[hi] as number) - (cum[lo] as number);
    const f = segLen <= 0 ? 0 : (s - (cum[lo] as number)) / segLen;
    const a = path[lo] as Point3;
    const b = path[hi] as Point3;
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      z: a.z + (b.z - a.z) * f,
    };
  };

  const points: TrajectoryPoint[] = [{ ...(path[0] as Point3), t: round1(t0) }];
  const n = Math.floor((endT - t0) / sampleS);
  for (let k = 1; k <= n; k++) {
    const t = t0 + k * sampleS;
    points.push({ ...positionAt(t), t: round1(t) });
  }
  const lastT = points[points.length - 1]?.t ?? 0;
  if (endT - lastT > 0.05) {
    points.push({ ...(path[path.length - 1] as Point3), t: round1(endT) });
  }

  return {
    id: `CT-${droneId}`,
    droneId,
    points,
    hTolerance,
    vTolerance,
    status: "active",
  };
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Interpolated contract position at sim time t. */
export function contractPointAt(c: TrajectoryContract, t: number): Point3 {
  const pts = c.points;
  if (t <= pts[0].t) return pts[0];
  const last = pts[pts.length - 1] as TrajectoryPoint;
  if (t >= last.t) return last;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1] as TrajectoryPoint;
    const p1 = pts[i] as TrajectoryPoint;
    if (t <= p1.t) {
      const f = p1.t === p0.t ? 0 : (t - p0.t) / (p1.t - p0.t);
      return {
        x: p0.x + (p1.x - p0.x) * f,
        y: p0.y + (p1.y - p0.y) * f,
        z: p0.z + (p1.z - p0.z) * f,
      };
    }
  }
  return last;
}

export interface ContractConflictInfo {
  otherDroneId: string;
  t: number;
  hDistM: number;
  vDistM: number;
}

/**
 * True when two contracts' tubes overlap in 4D: at some shared time the
 * horizontal separation is less than the sum of horizontal tolerances AND
 * vertical separation is less than the sum of vertical tolerances.
 */
export function contractsConflict(a: TrajectoryContract, b: TrajectoryContract): ContractConflictInfo | null {
  const a0 = a.points[0] as TrajectoryPoint;
  const a1 = a.points[a.points.length - 1] as TrajectoryPoint;
  const b0 = b.points[0] as TrajectoryPoint;
  const b1 = b.points[b.points.length - 1] as TrajectoryPoint;
  const tStart = Math.max(a0.t, b0.t);
  const tEnd = Math.min(a1.t, b1.t);
  if (tEnd <= tStart) return null;

  const hLimit = a.hTolerance + b.hTolerance;
  const vLimit = a.vTolerance + b.vTolerance;

  // Sample the overlap window at 1 s plus both endpoints.
  const times: number[] = [tStart, tEnd];
  for (let t = Math.ceil(tStart); t < tEnd; t++) times.push(t);

  for (const t of times) {
    const pa = contractPointAt(a, t);
    const pb = contractPointAt(b, t);
    const hd = dist2(pa.x, pa.y, pb.x, pb.y);
    const vd = Math.abs(pa.z - pb.z);
    if (hd < hLimit && vd < vLimit) {
      return { otherDroneId: b.droneId, t, hDistM: hd, vDistM: vd };
    }
  }
  return null;
}

/** Horizontal distance from a position to the contract path polyline. */
export function deviationFromContract(
  pos: Point3,
  c: TrajectoryContract,
  t?: number
): { hM: number; vM: number } {
  let minH = Infinity;
  const pts = c.points;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as TrajectoryPoint;
    const b = pts[i] as TrajectoryPoint;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((pos.x - a.x) * dx + (pos.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    const d = dist2(pos.x, pos.y, px, py);
    if (d < minH) minH = d;
  }
  // Vertical deviation vs the altitude the contract expects at time t
  // (falls back to the contract's final altitude when t is not given).
  const ref = t !== undefined ? contractPointAt(c, t) : contractPointAt(c, c.points[c.points.length - 1].t);
  const vM = Math.abs(pos.z - ref.z);
  return { hM: minH === Infinity ? 0 : minH, vM };
}
