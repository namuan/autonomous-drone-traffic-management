import { describe, expect, it } from "vitest";
import {
  dist2,
  nearestPointOnSegment,
  pointInCircle,
  pointInRect,
  segmentCircleIntersect,
  segmentRectIntersect,
} from "./geometry.js";
import { SeededRandom } from "./rng.js";

describe("geometry", () => {
  it("computes 2D distance", () => {
    expect(dist2(0, 0, 3, 4)).toBeCloseTo(5);
  });

  it("detects segment-rect intersection and misses", () => {
    const rect = { x: 100, y: 100, w: 50, h: 50 };
    expect(segmentRectIntersect(0, 0, 300, 300, rect)).toBe(true);
    expect(segmentRectIntersect(0, 0, 50, 50, rect)).toBe(false);
    expect(segmentRectIntersect(0, 300, 300, 300, rect)).toBe(false);
  });

  it("respects rect inflation margin", () => {
    const rect = { x: 100, y: 100, w: 50, h: 50 };
    // Segment passes 10 m above the rect; with a 12 m margin it must count as blocked.
    expect(segmentRectIntersect(0, 90, 300, 90, rect, 12)).toBe(true);
    expect(segmentRectIntersect(0, 90, 300, 90, rect, 0)).toBe(false);
  });

  it("detects segment-circle intersection", () => {
    const c = { x: 500, y: 500, r: 100 };
    expect(segmentCircleIntersect(0, 500, 1000, 500, c)).toBe(true);
    expect(segmentCircleIntersect(0, 0, 300, 300, c)).toBe(false);
  });

  it("finds nearest point on segment", () => {
    const n = nearestPointOnSegment(0, 0, 100, 0, 120, 30);
    expect(n.x).toBeCloseTo(100);
    expect(n.y).toBeCloseTo(0);
    const m = nearestPointOnSegment(0, 0, 100, 0, 50, 30);
    expect(m.x).toBeCloseTo(50);
    expect(m.y).toBeCloseTo(0);
  });

  it("point-in-rect and point-in-circle", () => {
    expect(pointInRect({ x: 5, y: 5, z: 0 }, { x: 0, y: 0, w: 10, h: 10 })).toBe(true);
    expect(pointInRect({ x: 15, y: 5, z: 0 }, { x: 0, y: 0, w: 10, h: 10 })).toBe(false);
    expect(pointInCircle({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, r: 2 })).toBe(true);
    expect(pointInCircle({ x: 3, y: 0, z: 0 }, { x: 0, y: 0, r: 2 })).toBe(false);
  });
});

describe("SeededRandom", () => {
  it("is deterministic for the same seed", () => {
    const a = new SeededRandom(42);
    const b = new SeededRandom(42);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("differs across seeds", () => {
    const a = new SeededRandom(1);
    const b = new SeededRandom(2);
    expect(a.next()).not.toBe(b.next());
  });

  it("produces values in range", () => {
    const r = new SeededRandom(7);
    for (let i = 0; i < 100; i++) {
      const v = r.range(10, 20);
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThan(20);
      const k = r.int(0, 5);
      expect(Number.isInteger(k)).toBe(true);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThanOrEqual(5);
    }
  });
});
