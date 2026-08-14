/**
 * RRT* (Rapidly-exploring Random Tree Star) global path planner.
 * Bounded iterations, seeded RNG, 2.5D: plans a horizontal polyline at a
 * given altitude lane around static geofences and weather cells.
 * This is a simulation-grade planner, not a 6-DOF certified flight plan.
 */

import { CONFIG } from "@utm/core";
import type { Obstacle, Point3 } from "@utm/core";
import { SeededRandom, dist2, segmentBlocked } from "@utm/core";

interface RrtOptions {
  maxIterations?: number;
  goalBias?: number;
  stepM?: number;
  rewireRadiusM?: number;
  margin?: number;
}

interface RrtNode {
  x: number;
  y: number;
  parent: number;
  cost: number;
}

export function planRrt(
  start: Point3,
  goal: Point3,
  obstacles: Obstacle[],
  rng: SeededRandom,
  opts: RrtOptions = {}
): Point3[] | null {
  const cfg = CONFIG.planning.rrt;
  const maxIterations = opts.maxIterations ?? cfg.maxIterations;
  const goalBias = opts.goalBias ?? cfg.goalBias;
  const stepM = opts.stepM ?? cfg.stepM;
  const rewireRadiusM = opts.rewireRadiusM ?? cfg.rewireRadiusM;
  const margin = opts.margin ?? cfg.obstacleMarginM;

  const z = start.z;
  const nodes: RrtNode[] = [{ x: start.x, y: start.y, parent: -1, cost: 0 }];
  let goalIndex = -1;

  const clear = (ax: number, ay: number, bx: number, by: number): boolean =>
    !segmentBlocked(ax, ay, bx, by, z, obstacles, margin);

  const nearestIndex = (x: number, y: number): number => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const d = dist2(nodes[i].x, nodes[i].y, x, y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  for (let it = 0; it < maxIterations; it++) {
    const sampleGoal = rng.next() < goalBias;
    const sx = sampleGoal ? goal.x : rng.range(0, CONFIG.sector.widthM);
    const sy = sampleGoal ? goal.y : rng.range(0, CONFIG.sector.heightM);

    const near = nearestIndex(sx, sy);
    const dx = sx - nodes[near].x;
    const dy = sy - nodes[near].y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const nx = d <= stepM ? sx : nodes[near].x + (dx / d) * stepM;
    const ny = d <= stepM ? sy : nodes[near].y + (dy / d) * stepM;

    if (!clear(nodes[near].x, nodes[near].y, nx, ny)) continue;

    const newIndex = nodes.length;
    nodes.push({ x: nx, y: ny, parent: near, cost: nodes[near].cost + d });

    // Rewire: connect nearby nodes through the new node if cheaper.
    for (let i = 0; i < nodes.length - 1; i++) {
      const nd = dist2(nodes[i].x, nodes[i].y, nx, ny);
      if (nd < rewireRadiusM && clear(nodes[i].x, nodes[i].y, nx, ny)) {
        const costVia = nodes[newIndex].cost + nd;
        if (costVia < nodes[i].cost) {
          nodes[i].parent = newIndex;
          nodes[i].cost = costVia;
        }
        const costFrom = nodes[i].cost + nd;
        if (costFrom < nodes[newIndex].cost) {
          nodes[newIndex].parent = i;
          nodes[newIndex].cost = costFrom;
        }
      }
    }

    if (!sampleGoal && dist2(nx, ny, goal.x, goal.y) <= stepM && clear(nx, ny, goal.x, goal.y)) {
      goalIndex = newIndex;
      break;
    }
    if (sampleGoal && dist2(nx, ny, goal.x, goal.y) < 1) {
      goalIndex = newIndex;
      break;
    }
  }

  if (goalIndex < 0) return null;

  // Walk the tree back to the root.
  const raw: { x: number; y: number }[] = [];
  let idx = goalIndex;
  while (idx >= 0) {
    raw.push({ x: nodes[idx].x, y: nodes[idx].y });
    idx = nodes[idx].parent;
  }
  raw.reverse();

  const path = smoothPath(raw, z, obstacles, margin);
  const out = path.map((p) => ({ x: p.x, y: p.y, z }));
  // Ensure the path actually terminates at the goal (RRT stops at a node
  // within one step of it; the connector segment is verified clear).
  const last = out[out.length - 1] as Point3;
  if (dist2(last.x, last.y, goal.x, goal.y) > 1 && !segmentBlocked(last.x, last.y, goal.x, goal.y, z, obstacles, margin)) {
    out.push({ x: goal.x, y: goal.y, z });
  }
  return out;
}

/** Greedy shortcut smoothing. */
export function smoothPath(
  raw: { x: number; y: number }[],
  z: number,
  obstacles: Obstacle[],
  margin: number
): { x: number; y: number }[] {
  if (raw.length <= 2) return raw;
  const out: { x: number; y: number }[] = [raw[0] as { x: number; y: number }];
  let anchor = 0;
  while (anchor < raw.length - 1) {
    let farthest = anchor + 1;
    for (let j = raw.length - 1; j > anchor; j--) {
      if (
        !segmentBlocked(
          raw[anchor].x,
          raw[anchor].y,
          (raw[j] as { x: number; y: number }).x,
          (raw[j] as { x: number; y: number }).y,
          z,
          obstacles,
          margin
        )
      ) {
        farthest = j;
        break;
      }
    }
    out.push(raw[farthest] as { x: number; y: number });
    anchor = farthest;
  }
  return out;
}
