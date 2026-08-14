/**
 * Velocity Obstacles (Layer 3 - emergency maneuvers).
 * Computes, per neighbor, the set of relative velocities that would lead to a
 * collision within the horizon, then picks the candidate velocity closest to
 * the preferred velocity that lies outside every velocity obstacle.
 * Cheap (O(candidates x neighbors)) and guaranteed safe for cooperative
 * agents in the idealized model.
 */

import type { Point3 } from "@utm/core";
import { CONFIG } from "@utm/core";
import type { NeighborPrediction } from "./mpc.js";

export interface VOInput {
  pos: Point3;
  vel: Point3;
  preferredVel: Point3;
  neighbors: NeighborPrediction[];
  maxSpeed: number;
}

export interface VOResult {
  vx: number;
  vy: number;
  vz: number;
  safe: boolean;
  minSepM: number;
}

const ROTATIONS_DEG = [0, 30, -30, 60, -60, 90, -90, 135, -135];
const FACTORS = [1.0, 0.85, 1.2];

export function computeVOVelocity(input: VOInput): VOResult {
  const horizon = CONFIG.vo.horizonS;
  const { pos, preferredVel, neighbors, maxSpeed } = input;

  const prefHeading = Math.atan2(preferredVel.y, preferredVel.x);
  const prefSpeed = Math.min(maxSpeed, Math.hypot(preferredVel.x, preferredVel.y) || 1);

  const candidates: { vx: number; vy: number; vz: number }[] = [];
  for (const rot of ROTATIONS_DEG) {
    for (const factor of FACTORS) {
      const heading = prefHeading + (rot * Math.PI) / 180;
      const speed = Math.min(maxSpeed, prefSpeed * factor);
      candidates.push({ vx: Math.cos(heading) * speed, vy: Math.sin(heading) * speed, vz: 0 });
    }
  }
  // Vertical escape options: keep the preferred course and climb/descend.
  candidates.push({ vx: preferredVel.x, vy: preferredVel.y, vz: 3 });
  candidates.push({ vx: preferredVel.x, vy: preferredVel.y, vz: -3 });
  candidates.push({ vx: preferredVel.x * 0.8, vy: preferredVel.y * 0.8, vz: 3 });
  candidates.push({ vx: preferredVel.x * 0.8, vy: preferredVel.y * 0.8, vz: -3 });

  const forbidden = (vx: number, vy: number, vz: number): { forbidden: boolean; minSep: number } => {
    let minSep = Infinity;
    for (const n of neighbors) {
      const p = { x: n.pos.x - pos.x, y: n.pos.y - pos.y };
      const rv = { x: vx - n.vel.x, y: vy - n.vel.y };
      const radius = n.radiusM;
      const pLen2 = p.x * p.x + p.y * p.y;
      if (pLen2 < 1) return { forbidden: true, minSep: 0 };
      // Closest approach within the horizon.
      const rvLen2 = rv.x * rv.x + rv.y * rv.y;
      let tca = rvLen2 < 1e-6 ? 0 : -(p.x * rv.x + p.y * rv.y) / rvLen2;
      tca = Math.max(0, Math.min(horizon, tca));
      const d = Math.hypot(p.x + rv.x * tca, p.y + rv.y * tca);
      if (d < minSep) minSep = d;
      // Vertical separation of 15 m counts as deconflicted (PLAN.md).
      const vd = Math.abs(pos.z + vz * tca - (n.pos.z + n.vel.z * tca));
      if (d < radius && vd < CONFIG.separation.minVertSepM) return { forbidden: true, minSep: d };
    }
    return { forbidden: false, minSep };
  };

  const deviationScore = (vx: number, vy: number, vz: number): number => {
    const heading = Math.atan2(vy, vx);
    const dHeading = Math.abs(((heading - prefHeading + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    const speed = Math.hypot(vx, vy);
    return dHeading + (Math.abs(speed - prefSpeed) / prefSpeed) * 0.5 + Math.abs(vz) * 0.05;
  };

  let bestSafe: { vx: number; vy: number; vz: number; score: number; minSep: number } | null = null;
  let bestUnsafe: { vx: number; vy: number; vz: number; score: number; minSep: number } | null = null;

  for (const c of candidates) {
    const speed = Math.hypot(c.vx, c.vy);
    if (speed > maxSpeed + 0.01) continue;
    const { forbidden: bad, minSep } = forbidden(c.vx, c.vy, c.vz);
    const score = deviationScore(c.vx, c.vy, c.vz);
    if (!bad) {
      if (!bestSafe || score < bestSafe.score) bestSafe = { ...c, score, minSep };
    } else if (!bestUnsafe || minSep > bestUnsafe.minSep) {
      bestUnsafe = { ...c, score, minSep };
    }
  }

  const chosen = bestSafe ?? bestUnsafe ?? { vx: preferredVel.x, vy: preferredVel.y, vz: 0, score: 0, minSep: 0 };
  return {
    vx: chosen.vx,
    vy: chosen.vy,
    vz: chosen.vz,
    safe: bestSafe !== null,
    minSepM: chosen.minSep,
  };
}
