/**
 * Tactical deconfliction: a small receding-horizon (MPC-like) controller.
 * At each 100 ms tick it scores a discrete set of acceleration candidates
 * over a 3 s horizon against route deviation, energy, weather and separation
 * from predicted neighbor positions, then applies the best candidate's first
 * action. If the best candidate still cannot preserve clearance, control
 * falls through to the velocity-obstacle module (emergency maneuvers).
 *
 * Simulation-grade: not a certified aircraft control law.
 */

import { CONFIG } from "@utm/core";
import type { Point3, WeatherZone } from "@utm/core";
import { dist2 } from "@utm/core";
import { computeVOVelocity } from "./vo.js";

export interface NeighborPrediction {
  pos: Point3;
  vel: Point3;
  radiusM: number;
}

export interface ControlInput {
  pos: Point3;
  vel: Point3;
  cruiseSpeed: number;
  maxSpeed: number;
  laneZ: number;
  route: Point3[]; // remaining planned path (downsampled ok)
  /** Lookahead point along the contract (about one horizon ahead). */
  target?: Point3;
  neighbors: NeighborPrediction[];
  weather: WeatherZone[];
  /** Per-drone asymmetry for the VO fallback (breaks mirror dances). */
  biasDeg?: number;
}

export interface ControlResult {
  vx: number;
  vy: number;
  vz: number;
  speedMps: number;
  headingDeg: number;
  mode: "mpc" | "vo";
  minSepM: number;
  score: number;
}

interface Candidate {
  vx: number;
  vy: number;
  vz: number;
  score: number;
  minSepM: number;
}

const ROUTE_SAMPLE_EVERY = 3;

export function computeControl(input: ControlInput): ControlResult {
  const cfg = CONFIG.mpc;
  const { pos, vel, route, neighbors, weather } = input;
  const samples = Math.round(cfg.horizonS / cfg.sampleStepS);
  const step = cfg.sampleStepS;

  // Downsample the route for fast distance queries (always keep a segment).
  const routePts: Point3[] = [];
  for (let i = 0; i < route.length; i += ROUTE_SAMPLE_EVERY) routePts.push(route[i] as Point3);
  if (routePts.length === 0) routePts.push(pos);
  if (routePts.length === 1 && route.length > 1) routePts.push(route[route.length - 1] as Point3);

  const curHeading = Math.atan2(vel.y, vel.x);
  const w = cfg.weights;

  const distanceToRoute = (x: number, y: number, z: number): number => {
    let best =
      routePts.length > 0
        ? Math.hypot(x - (routePts[0] as Point3).x, y - (routePts[0] as Point3).y, z - (routePts[0] as Point3).z)
        : Infinity;
    for (let i = 1; i < routePts.length; i++) {
      const a = routePts[i - 1] as Point3;
      const b = routePts[i] as Point3;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const len2 = dx * dx + dy * dy + dz * dz;
      let t = len2 === 0 ? 0 : ((x - a.x) * dx + (y - a.y) * dy + (z - a.z) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + t * dx;
      const py = a.y + t * dy;
      const pz = a.z + t * dz;
      const d = Math.hypot(x - px, y - py, z - pz);
      if (d < best) best = d;
    }
    return best;
  };

  const candidates: Candidate[] = [];
  for (const headingOff of cfg.headingOffsetsDeg) {
    for (const speedFactor of cfg.speedFactors) {
      for (const zRate of cfg.zRates) {
        const heading = curHeading + (headingOff * Math.PI) / 180;
        const speed = Math.min(input.maxSpeed, input.cruiseSpeed * speedFactor);
        const vx = Math.cos(heading) * speed;
        const vy = Math.sin(heading) * speed;
        const vz = zRate;

        // Simulate the candidate over the horizon.
        let pathDev = 0;
        let targetDev = 0;
        let weatherPenalty = 0;
        let sepPenalty = 0;
        let altPenalty = 0;
        let minSep = Infinity;
        let sx = pos.x;
        let sy = pos.y;
        let sz = pos.z;
        for (let s = 1; s <= samples; s++) {
          sx += vx * step;
          sy += vy * step;
          sz += vz * step;
          const t = s * step;

          pathDev += distanceToRoute(sx, sy, sz) / 60;
          if (input.target) {
            // Sqrt scaling keeps the term discriminative close to the goal.
            targetDev += Math.sqrt(Math.hypot(sx - input.target.x, sy - input.target.y, sz - input.target.z)) / 10;
          }
          altPenalty += Math.abs(sz - input.laneZ) / 60;

          for (const wz of weather) {
            const d = dist2(sx, sy, wz.center.x, wz.center.y);
            if (d < wz.radius) {
              weatherPenalty += wz.intensity * 2 * (1 - d / wz.radius);
            }
          }

          for (const n of neighbors) {
            const nx = n.pos.x + n.vel.x * t;
            const ny = n.pos.y + n.vel.y * t;
            const nz = n.pos.z + n.vel.z * t;
            const hd = dist2(sx, sy, nx, ny);
            const vd = Math.abs(sz - nz);
            const margin = n.radiusM;
            if (vd < CONFIG.separation.minVertSepM) {
              const deficit = margin - hd;
              if (deficit > 0) sepPenalty += deficit / margin;
              if (hd < minSep) minSep = hd;
            }
          }
        }

        const energy = Math.abs(speed - input.cruiseSpeed) / input.cruiseSpeed;
        const turn = Math.abs(((heading - curHeading + Math.PI * 3) % (Math.PI * 2)) - Math.PI) / Math.PI;

        const score =
          w.path * (pathDev / samples) +
          w.target * (targetDev / samples) +
          w.energy * energy +
          w.weather * (weatherPenalty / samples) +
          w.separation * (sepPenalty / samples) +
          w.turn * turn +
          w.altitude * (altPenalty / samples);

        candidates.push({ vx, vy, vz, score, minSepM: minSep });
      }
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0] as Candidate;

  // Emergency fallback: if the best MPC candidate cannot preserve clearance,
  // engage the velocity-obstacle layer.
  if (best.minSepM < cfg.voFallbackMarginM && neighbors.length > 0) {
    const preferred = { x: best.vx, y: best.vy, z: 0 };
    const vo = computeVOVelocity({
      pos,
      vel,
      preferredVel: preferred,
      neighbors,
      maxSpeed: input.maxSpeed,
      biasDeg: input.biasDeg,
    });
    return {
      vx: vo.vx,
      vy: vo.vy,
      vz: vo.vz,
      speedMps: Math.hypot(vo.vx, vo.vy),
      headingDeg: (Math.atan2(vo.vy, vo.vx) * 180) / Math.PI,
      mode: "vo",
      minSepM: vo.minSepM,
      score: best.score,
    };
  }

  return {
    vx: best.vx,
    vy: best.vy,
    vz: best.vz,
    speedMps: Math.hypot(best.vx, best.vy),
    headingDeg: (Math.atan2(best.vy, best.vx) * 180) / Math.PI,
    mode: "mpc",
    minSepM: best.minSepM,
    score: best.score,
  };
}

export { computeVOVelocity } from "./vo.js";
