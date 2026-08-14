/**
 * A* tactical replanner on a 10 m resolution grid over the sector.
 * Used when a drone must re-route around newly appeared weather cells or
 * recover from non-conformance. Returns a smoothed 2D polyline at altitude z.
 */

import { CONFIG } from "@utm/core";
import type { Obstacle, Point3 } from "@utm/core";
import { pointBlocked } from "@utm/core";

interface Cell {
  g: number;
  f: number;
  parent: number;
  closed: boolean;
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

export function planAStar(
  start: Point3,
  goal: Point3,
  obstacles: Obstacle[],
  opts: { resolutionM?: number; margin?: number } = {}
): Point3[] | null {
  const res = opts.resolutionM ?? CONFIG.planning.astar.resolutionM;
  const margin = opts.margin ?? CONFIG.planning.astar.obstacleMarginM;
  const w = Math.ceil(CONFIG.sector.widthM / res);
  const h = Math.ceil(CONFIG.sector.heightM / res);

  const toCell = (v: number, max: number): number => Math.min(max - 1, Math.max(0, Math.floor(v / res)));
  const sx = toCell(start.x, w);
  const sy = toCell(start.y, h);
  const gx = toCell(goal.x, w);
  const gy = toCell(goal.y, h);

  const blockedCell = (cx: number, cy: number): boolean => {
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return true;
    return pointBlocked({ x: (cx + 0.5) * res, y: (cy + 0.5) * res, z: start.z }, obstacles, margin);
  };

  if (blockedCell(gx, gy)) return null;

  const cells = new Map<number, Cell>();
  const key = (cx: number, cy: number): number => cy * w + cx;
  const heuristic = (cx: number, cy: number): number => Math.hypot(cx - gx, cy - gy) * res;

  const open: { k: number; f: number }[] = [];
  const push = (k: number, f: number) => {
    open.push({ k, f });
    open.sort((a, b) => a.f - b.f);
  };

  cells.set(key(sx, sy), { g: 0, f: heuristic(sx, sy), parent: -1, closed: false });
  push(key(sx, sy), heuristic(sx, sy));

  let found = -1;
  let guard = 0;
  while (open.length > 0 && guard++ < 200_000) {
    const cur = open.shift();
    if (!cur) break;
    const c = cells.get(cur.k);
    if (!c || c.closed) continue;
    if (cur.k === key(gx, gy)) {
      found = cur.k;
      break;
    }
    c.closed = true;
    const cx = cur.k % w;
    const cy = Math.floor(cur.k / w);
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (blockedCell(nx, ny)) continue;
      const nk = key(nx, ny);
      const nc = cells.get(nk);
      const step = dx !== 0 && dy !== 0 ? Math.SQRT2 * res : res;
      const ng = c.g + step;
      if (!nc) {
        cells.set(nk, { g: ng, f: ng + heuristic(nx, ny), parent: cur.k, closed: false });
        push(nk, ng + heuristic(nx, ny));
      } else if (!nc.closed && ng < nc.g) {
        nc.g = ng;
        nc.f = ng + heuristic(nx, ny);
        nc.parent = cur.k;
        push(nk, nc.f);
      }
    }
  }

  if (found < 0) return null;

  const raw: { x: number; y: number }[] = [];
  let k = found;
  while (k >= 0) {
    const cx = k % w;
    const cy = Math.floor(k / w);
    raw.push({ x: (cx + 0.5) * res, y: (cy + 0.5) * res });
    const c = cells.get(k);
    k = c && c.parent >= 0 ? c.parent : -1;
  }
  raw.reverse();

  // Greedy smoothing (reuse the RRT smoother via segmentBlocked on the grid).
  const out: { x: number; y: number }[] = [raw[0] as { x: number; y: number }];
  let anchor = 0;
  while (anchor < raw.length - 1) {
    let farthest = anchor + 1;
    for (let j = raw.length - 1; j > anchor; j--) {
      const a = raw[anchor] as { x: number; y: number };
      const b = raw[j] as { x: number; y: number };
      if (!segmentBlockedOnGrid(a.x, a.y, b.x, b.y, w, h, res, blockedCell)) {
        farthest = j;
        break;
      }
    }
    out.push(raw[farthest] as { x: number; y: number });
    anchor = farthest;
  }

  const finalPath = out.map((p) => ({ x: p.x, y: p.y, z: start.z }));
  // Terminate exactly at the goal when the final connector is clear.
  const last = finalPath[finalPath.length - 1] as Point3;
  if (
    (Math.abs(last.x - goal.x) > 1 || Math.abs(last.y - goal.y) > 1) &&
    !segmentBlockedOnGrid(last.x, last.y, goal.x, goal.y, w, h, res, blockedCell)
  ) {
    finalPath.push({ x: goal.x, y: goal.y, z: start.z });
  }
  return finalPath;
}

function segmentBlockedOnGrid(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  w: number,
  h: number,
  res: number,
  blockedCell: (cx: number, cy: number) => boolean
): boolean {
  const dist = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(2, Math.ceil(dist / (res * 0.5)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = Math.min(w - 1, Math.max(0, Math.floor((ax + (bx - ax) * t) / res)));
    const cy = Math.min(h - 1, Math.max(0, Math.floor((ay + (by - ay) * t) / res)));
    if (blockedCell(cx, cy)) return true;
  }
  return false;
}
