/** Geometry helpers. All coordinates are meters in the sector frame. */

import type { Circle, Point3, Rect } from "./types.js";

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const dist2 = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
};

export const dist3 = (a: Point3, b: Point3): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

export const pointInRect = (p: Point3, r: Rect, margin = 0): boolean =>
  p.x >= r.x - margin &&
  p.x <= r.x + r.w + margin &&
  p.y >= r.y - margin &&
  p.y <= r.y + r.h + margin;

/** Does segment a-b intersect axis-aligned rect (optionally inflated by margin)? */
export const segmentRectIntersect = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: Rect,
  margin = 0
): boolean => {
  const x0 = r.x - margin;
  const y0 = r.y - margin;
  const x1 = r.x + r.w + margin;
  const y1 = r.y + r.h + margin;
  // Clip segment against the rect using Liang-Barsky.
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return true;
};

export const pointInCircle = (p: Point3, c: Circle, margin = 0): boolean =>
  dist2(p.x, p.y, c.x, c.y) <= c.r + margin;

/** Does segment a-b intersect circle (optionally inflated by margin)? */
export const segmentCircleIntersect = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  c: Circle,
  margin = 0
): boolean => {
  const r = c.r + margin;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return pointInCircle({ x: ax, y: ay, z: 0 }, c, margin);
  let t = ((c.x - ax) * dx + (c.y - ay) * dy) / len2;
  t = clamp(t, 0, 1);
  const px = ax + t * dx;
  const py = ay + t * dy;
  return dist2(px, py, c.x, c.y) <= r;
};

/** Nearest point on segment a-b to point p. */
export const nearestPointOnSegment = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number
): { x: number; y: number; t: number } => {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { x: ax, y: ay, t: 0 };
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  return { x: ax + t * dx, y: ay + t * dy, t };
};

export const polylineLength = (pts: Point3[]): number => {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += dist2(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
  }
  return len;
};

export interface Obstacle {
  rect?: Rect;
  circle?: Circle;
  zMin?: number;
  zMax?: number;
}

/** Does a horizontal segment at altitude z collide with any obstacle? */
export const segmentBlocked = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  z: number,
  obstacles: Obstacle[],
  margin = 0
): boolean => {
  for (const o of obstacles) {
    if (o.zMin !== undefined && (z < o.zMin || z > (o.zMax ?? Infinity))) continue;
    if (o.rect && segmentRectIntersect(ax, ay, bx, by, o.rect, margin)) return true;
    if (o.circle && segmentCircleIntersect(ax, ay, bx, by, o.circle, margin)) return true;
  }
  return false;
};

export const pointBlocked = (p: Point3, obstacles: Obstacle[], margin = 0): boolean => {
  for (const o of obstacles) {
    if (o.zMin !== undefined && (p.z < o.zMin || p.z > (o.zMax ?? Infinity))) continue;
    if (o.rect && pointInRect(p, o.rect, margin)) return true;
    if (o.circle && pointInCircle(p, o.circle, margin)) return true;
  }
  return false;
};
