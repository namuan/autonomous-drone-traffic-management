/**
 * Spatiotemporal index: in-memory time-bucketed 4D store.
 * Holds active trajectory contracts (future reservations) plus a ring of
 * recorded telemetry (past positions). Answers "which drones pass through
 * this cube during this time window" and performs strategic deconfliction
 * checks for candidate contracts.
 *
 * Repository interfaces mirror what a PostGIS + TimescaleDB + octree backend
 * would provide at production scale; this is the simulation adapter.
 */

import type { AirspaceQuery, AirspaceQueryResult, Point3, TrajectoryContract } from "@utm/core";
import { contractsConflict } from "@utm/autonomy";

interface TelemetrySample {
  t: number;
  droneId: string;
  pos: Point3;
}

export class SpacetimeIndex {
  private contracts = new Map<string, TrajectoryContract>();
  private telemetry: TelemetrySample[] = [];
  private maxTelemetry = 20_000;

  addContract(c: TrajectoryContract): void {
    this.contracts.set(c.id, c);
  }

  releaseContract(id: string): void {
    this.contracts.delete(id);
  }

  getContract(id: string): TrajectoryContract | undefined {
    return this.contracts.get(id);
  }

  get contractCount(): number {
    return this.contracts.size;
  }

  /** Strategic deconfliction: does the candidate conflict with any stored contract? */
  conflicts(candidate: TrajectoryContract, excludeDroneId?: string): TrajectoryContract[] {
    const out: TrajectoryContract[] = [];
    for (const c of this.contracts.values()) {
      if (c.droneId === excludeDroneId) continue;
      if (c.status !== "active") continue;
      if (contractsConflict(candidate, c)) out.push(c);
    }
    return out;
  }

  recordTelemetry(droneId: string, t: number, pos: Point3): void {
    this.telemetry.push({ t, droneId, pos });
    if (this.telemetry.length > this.maxTelemetry) {
      this.telemetry.splice(0, this.telemetry.length - this.maxTelemetry);
    }
  }

  clearTelemetry(): void {
    this.telemetry = [];
  }

  /** All drones that pass through the cube in [t0, t1], from contracts or recorded positions. */
  queryCube(q: AirspaceQuery): AirspaceQueryResult {
    const t0 = Math.min(q.t0, q.t1);
    const t1 = Math.max(q.t0, q.t1);
    const inCube = (p: Point3, padH: number, padV: number): boolean =>
      p.x >= q.x0 - padH &&
      p.x <= q.x1 + padH &&
      p.y >= q.y0 - padH &&
      p.y <= q.y1 + padH &&
      p.z >= q.z0 - padV &&
      p.z <= q.z1 + padV;

    const matches: AirspaceQueryResult["matches"] = [];
    const seen = new Set<string>();

    // Future/planned: contract samples.
    for (const c of this.contracts.values()) {
      if (c.status !== "active") continue;
      const key = `C:${c.droneId}`;
      if (seen.has(key)) continue;
      for (const pt of c.points) {
        if (pt.t >= t0 && pt.t <= t1 && inCube(pt, c.hTolerance, c.vTolerance)) {
          matches.push({ droneId: c.droneId, from: "contract", t: pt.t });
          seen.add(key);
          break;
        }
      }
    }

    // Past: recorded telemetry.
    for (const s of this.telemetry) {
      if (s.t >= t0 && s.t <= t1) {
        const key = `T:${s.droneId}`;
        if (seen.has(key)) continue;
        if (inCube(s.pos, 0, 0)) {
          matches.push({ droneId: s.droneId, from: "telemetry", t: s.t });
          seen.add(key);
        }
      }
    }

    return {
      cube: q,
      matches,
      contractCount: matches.filter((m) => m.from === "contract").length,
      telemetryCount: matches.filter((m) => m.from === "telemetry").length,
    };
  }
}
