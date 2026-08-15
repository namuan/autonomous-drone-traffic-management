import { describe, expect, it } from "vitest";
import type { DroneView, Snapshot } from "@utm/core";
import {
  BG_HEX,
  FPV_BASE_SPEED,
  FPV_BOOST,
  FPV_PITCH_LIMIT,
  cameraMarkerRotation,
  classifyGesture,
  clampPitch,
  damp,
  droneScenePos,
  fpvCaptureActive,
  fpvDirection,
  fpvRight,
  fpvStep,
  flightModeState,
  followState,
  headingYawRad,
  hexToRgb,
  interpAlpha,
  lerp3,
  releaseFollowState,
  ringsFor,
  sceneToWorld,
  trailFade,
  worldToScene,
  wrapYaw,
  type SimFrame,
} from "./math.js";

const W = 2000;
const H = 1000;

const snap = (): Snapshot =>
  ({
    tick: 1,
    simTimeS: 0,
    paused: false,
    sector: { widthM: W, heightM: H, zMax: 150 },
    geofences: [],
    landingSites: [],
    weather: [],
    drones: [],
    meshLinks: [],
    counters: {
      contractsIssued: 0,
      contractsRejected: 0,
      reroutes: 0,
      safetyBreaches: 0,
      conformanceAlerts: 0,
      untrustedFlags: 0,
      lostLinkEvents: 0,
      weatherEvents: 0,
      auditEntries: 0,
      gatewayEvents: 0,
      nearMissPairs: 0,
    },
    recentEvents: [],
  }) as Snapshot;

const drone = (over: Partial<DroneView>): DroneView =>
  ({
    id: "d1",
    callsign: "UTM-1",
    role: "delivery",
    state: "en-route",
    flags: { untrusted: false, lostLink: false, criticalBattery: false },
    conformance: "conforming",
    x: 0,
    y: 0,
    z: 50,
    vx: 0,
    vy: 0,
    vz: 0,
    headingDeg: 0,
    speedMps: 10,
    batteryPct: 100,
    trust: 1,
    primarySource: "ads-b",
    sources: [],
    route: [],
    trail: [],
    contractId: null,
    contractStatus: null,
    deviationM: 0,
    targetLabel: null,
    ...over,
  }) as DroneView;

describe("coordinate conversion", () => {
  it("maps sector meters to scene units with the sector centered at origin", () => {
    expect(worldToScene(0, 0, 0, W, H)).toEqual({ x: -1000, y: 0, z: -500 });
    expect(worldToScene(2000, 1000, 150, W, H)).toEqual({ x: 1000, y: 150, z: 500 });
    expect(worldToScene(1000, 500, 75, W, H)).toEqual({ x: 0, y: 75, z: 0 });
  });

  it("round-trips through sceneToWorld", () => {
    for (const [x, y, z] of [
      [0, 0, 0],
      [1234, 567, 89],
      [2000, 1000, 150],
    ]) {
      const s = worldToScene(x, y, z, W, H);
      expect(sceneToWorld(s.x, s.y, s.z, W, H)).toEqual({ x, y, z });
    }
  });
});

describe("interpolation", () => {
  it("snaps to current when there is no previous frame, paused, or reduced motion", () => {
    const frame: SimFrame = { current: snap(), previous: null, receivedAtMs: 1000 };
    expect(interpAlpha(frame, 1050, false, false)).toBe(1);
    const withPrev: SimFrame = { current: snap(), previous: snap(), receivedAtMs: 1000 };
    expect(interpAlpha(withPrev, 1050, true, false)).toBe(1);
    expect(interpAlpha(withPrev, 1050, false, true)).toBe(1);
  });

  it("eases from previous to current over one tick, clamped", () => {
    const frame: SimFrame = { current: snap(), previous: snap(), receivedAtMs: 1000 };
    expect(interpAlpha(frame, 1000, false, false)).toBe(0);
    expect(interpAlpha(frame, 1050, false, false)).toBe(0.5);
    expect(interpAlpha(frame, 1100, false, false)).toBe(1);
    expect(interpAlpha(frame, 999, false, false)).toBe(0);
    expect(interpAlpha(frame, 5000, false, false)).toBe(1);
  });

  it("snaps for drones not present in the previous snapshot", () => {
    const cur = drone({ x: 100, y: 100, z: 50 });
    const alpha = droneScenePos(cur, null, 0.5, W, H);
    expect(alpha).toEqual(worldToScene(100, 100, 50, W, H));
  });

  it("lerps drone positions between observations", () => {
    const cur = drone({ x: 100, y: 100, z: 50 });
    const prev = drone({ x: 0, y: 0, z: 40 });
    const mid = droneScenePos(cur, prev, 0.5, W, H);
    expect(mid).toEqual({ x: -950, y: 45, z: -450 });
    const full = droneScenePos(cur, prev, 2, W, H);
    expect(full).toEqual(worldToScene(100, 100, 50, W, H));
  });

  it("lerp3 interpolates components", () => {
    expect(lerp3({ x: 0, y: 0, z: 0 }, { x: 10, y: 20, z: 30 }, 0.25)).toEqual({ x: 2.5, y: 5, z: 7.5 });
  });
});

describe("visual state mapping", () => {
  it("maps roles to the console palette", () => {
    expect(hexToRgb(0x38bdf8)).toEqual({ r: 0x38 / 255, g: 0xbd / 255, b: 0xf8 / 255 });
    const d = trailFade("delivery", 1);
    const c = hexToRgb(0x38bdf8);
    expect(d.r).toBeCloseTo(c.r, 10);
    expect(d.g).toBeCloseTo(c.g, 10);
    expect(d.b).toBeCloseTo(c.b, 10);
    const s = trailFade("surveillance", 1);
    expect(s.b).toBeCloseTo(hexToRgb(0xc084fc).b, 10);
  });

  it("fades trail origins toward the background color", () => {
    const old = trailFade("delivery", 0);
    expect(old).toEqual(hexToRgb(BG_HEX));
    const mid = trailFade("delivery", 0.5);
    expect(mid.r).toBeGreaterThan(hexToRgb(BG_HEX).r);
    expect(mid.r).toBeLessThan(hexToRgb(0x38bdf8).r);
  });

  it("stacks state rings with the 2D console color language", () => {
    const base = drone({});
    expect(ringsFor(base, true)).toEqual([{ kind: "selected", color: 0xf8fafc, dashed: false, radiusOffsetM: 5 }]);
    const messy = drone({ flags: { untrusted: true, lostLink: true, criticalBattery: true }, state: "rerouting" });
    const rings = ringsFor(messy, true);
    expect(rings.map((r) => r.kind)).toEqual(["selected", "critical", "untrusted", "lost", "reroute"]);
    expect(rings.find((r) => r.kind === "untrusted")?.dashed).toBe(true);
    expect(rings.find((r) => r.kind === "critical")?.color).toBe(0xf87171);
  });
});

describe("gesture + smoothing", () => {
  it("classifies small pointer movement as a click, larger as a drag", () => {
    expect(classifyGesture(0)).toBe("click");
    expect(classifyGesture(4.9)).toBe("click");
    expect(classifyGesture(5.1)).toBe("drag");
    expect(classifyGesture(40)).toBe("drag");
  });

  it("damps toward the target with faster convergence for higher lambda", () => {
    let v = 0;
    for (let i = 0; i < 60; i++) v = damp(v, 100, 4, 16.7);
    expect(v).toBeGreaterThan(98);
    let slow = 0;
    for (let i = 0; i < 60; i++) slow = damp(slow, 100, 0.5, 16.7);
    expect(slow).toBeLessThan(50);
    expect(damp(10, 10, 4, 16.7)).toBe(10);
  });

  it("converts sim heading to scene yaw", () => {
    expect(headingYawRad(0)).toBeCloseTo(0, 10);
    expect(headingYawRad(90)).toBeCloseTo(-Math.PI / 2, 10);
    expect(headingYawRad(180)).toBeCloseTo(-Math.PI, 10);
  });
});

describe("FPV flight math", () => {
  it("derives the look direction from yaw/pitch", () => {
    const d0 = fpvDirection(0, 0);
    expect(d0.x).toBeCloseTo(0, 10);
    expect(d0.y).toBeCloseTo(0, 10);
    expect(d0.z).toBeCloseTo(1, 10); // yaw 0 faces +Z (north)
    const e = fpvDirection(Math.PI / 2, 0);
    expect(e.x).toBeCloseTo(1, 10);
    expect(e.z).toBeCloseTo(0, 10);
    const up = fpvDirection(0, Math.PI / 4);
    expect(up.y).toBeCloseTo(Math.SQRT1_2, 10);
    expect(up.z).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it("strafe right is perpendicular to the heading", () => {
    const r = fpvRight(0);
    expect(r.x).toBeCloseTo(1, 10);
    expect(r.z).toBeCloseTo(0, 10);
  });

  it("normalizes diagonal input so speed never exceeds the base", () => {
    const dt = 16.7;
    const run = (input: Parameters<typeof fpvStep>[1], steps = 150) => {
      let pose = { pos: { x: 0, y: 50, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
      for (let i = 0; i < steps; i++) pose = fpvStep(pose, input, 0, 0, dt, 2000, 1000, 150);
      return pose;
    };
    const straight = run({ fwd: 1, strafe: 0, up: 0, boost: 1 });
    const diagonal = run({ fwd: 1, strafe: 1, up: 0, boost: 1 });
    const speedOf = (p: { vel: { x: number; y: number; z: number } }) => Math.hypot(p.vel.x, p.vel.y, p.vel.z);
    expect(speedOf(straight)).toBeCloseTo(FPV_BASE_SPEED, 1);
    expect(speedOf(diagonal)).toBeLessThanOrEqual(FPV_BASE_SPEED + 0.01);
    // Equal speeds -> each diagonal leg is the straight leg / sqrt(2).
    expect(diagonal.pos.x).toBeCloseTo(straight.pos.z / Math.SQRT2, 0);
  });

  it("accelerates with damping and decays to rest without input", () => {
    let pose = { pos: { x: 0, y: 50, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
    pose = fpvStep(pose, { fwd: 1, strafe: 0, up: 0, boost: 1 }, 0, 0, 16.7, 2000, 1000, 150);
    expect(pose.vel.z).toBeLessThan(FPV_BASE_SPEED); // still accelerating
    for (let i = 0; i < 200; i++) pose = fpvStep(pose, { fwd: 0, strafe: 0, up: 0, boost: 1 }, 0, 0, 16.7, 2000, 1000, 150);
    expect(Math.hypot(pose.vel.x, pose.vel.y, pose.vel.z)).toBeLessThan(0.001);
  });

  it("applies boost as a speed multiplier", () => {
    let pose = { pos: { x: 0, y: 50, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
    for (let i = 0; i < 200; i++) pose = fpvStep(pose, { fwd: 1, strafe: 0, up: 0, boost: 2 }, 0, 0, 16.7, 2000, 1000, 150);
    expect(Math.hypot(pose.vel.x, pose.vel.y, pose.vel.z)).toBeCloseTo(FPV_BASE_SPEED * FPV_BOOST, 1);
    expect(pose.pos.z).toBeLessThan(492); // stayed inside the sector footprint
  });

  it("clamps to the sector footprint and zeroes clamped velocity", () => {
    let pose = { pos: { x: 0, y: 50, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
    for (let i = 0; i < 700; i++) pose = fpvStep(pose, { fwd: 1, strafe: 0, up: 0, boost: 1 }, 0, 0, 16.7, 2000, 1000, 150);
    expect(pose.pos.z).toBeLessThanOrEqual(500 - 8 + 0.001);
    expect(pose.vel.z).toBe(0);
    // Climbing above the ceiling is also stopped.
    pose = { pos: { x: 0, y: 50, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
    for (let i = 0; i < 400; i++) pose = fpvStep(pose, { fwd: 0, strafe: 0, up: 1, boost: 1 }, 0, 0, 16.7, 2000, 1000, 150);
    expect(pose.pos.y).toBeLessThanOrEqual(150 + 120 + 0.001);
    expect(pose.vel.y).toBe(0);
  });

  it("caps long frame deltas", () => {
    const pose = { pos: { x: 0, y: 50, z: 0 }, vel: { x: 55, y: 0, z: 0 } };
    const stepped = fpvStep(pose, { fwd: 0, strafe: 0, up: 0, boost: 1 }, 0, 0, 5000, 2000, 1000, 150);
    expect(stepped.pos.x).toBeLessThan(0.25 * 55 + 1); // dt capped at 250 ms
  });

  it("wraps yaw and clamps pitch", () => {
    expect(wrapYaw(Math.PI * 1.5)).toBeCloseTo(-Math.PI / 2, 10);
    expect(wrapYaw(-Math.PI * 1.5)).toBeCloseTo(Math.PI / 2, 10);
    expect(wrapYaw(Math.PI)).toBeCloseTo(-Math.PI, 10);
    expect(clampPitch(2)).toBeCloseTo(FPV_PITCH_LIMIT, 10);
    expect(clampPitch(-2)).toBeCloseTo(-FPV_PITCH_LIMIT, 10);
    expect(clampPitch(0.2)).toBe(0.2);
  });

  it("captures keys only in FPV mode while locked", () => {
    expect(fpvCaptureActive("fpv", true)).toBe(true);
    expect(fpvCaptureActive("fpv", false)).toBe(false);
    expect(fpvCaptureActive("orbit", true)).toBe(false);
    expect(fpvCaptureActive("follow", true)).toBe(false);
  });

  it("orients the minimap marker for a screen-down north", () => {
    // 0 deg (facing +Z) points screen-down; +90 deg (east) points screen-right.
    expect(Math.sin(cameraMarkerRotation(0))).toBeCloseTo(0, 10);
    expect(Math.cos(cameraMarkerRotation(0))).toBeCloseTo(-1, 10);
    expect(Math.sin(cameraMarkerRotation(90))).toBeCloseTo(1, 10);
    expect(Math.cos(cameraMarkerRotation(90))).toBeCloseTo(0, 10);
    expect(Math.sin(cameraMarkerRotation(180))).toBeCloseTo(0, 10);
    expect(Math.cos(cameraMarkerRotation(180))).toBeCloseTo(1, 10);
    expect(Math.sin(cameraMarkerRotation(270))).toBeCloseTo(-1, 10);
    expect(Math.cos(cameraMarkerRotation(270))).toBeCloseTo(0, 10);
  });
});

describe("camera mode state machine", () => {
  it("follow release returns to the preferred flight mode", () => {
    const following = { kind: "follow" as const, droneId: "d1" };
    expect(releaseFollowState(following, "fpv")).toEqual({ kind: "fpv", droneId: null });
    expect(releaseFollowState(following, "orbit")).toEqual({ kind: "orbit", droneId: null });
  });

  it("release is a no-op when not following", () => {
    const orbit = { kind: "orbit" as const, droneId: null };
    expect(releaseFollowState(orbit, "fpv")).toBe(orbit);
  });

  it("follow engagement keeps the preferred mode untouched", () => {
    const state = followState({ kind: "fpv", droneId: null }, "fpv", "d7");
    expect(state).toEqual({ kind: "follow", droneId: "d7" });
  });

  it("re-following the same drone is a no-op; a new target replaces it", () => {
    const state = { kind: "follow" as const, droneId: "d1" };
    expect(followState(state, "orbit", "d1")).toBe(state);
    expect(followState(state, "orbit", "d2")).toEqual({ kind: "follow", droneId: "d2" });
    expect(followState(state, "orbit", null)).toEqual({ kind: "orbit", droneId: null });
  });

  it("flight mode selection never produces follow", () => {
    expect(flightModeState("fpv")).toEqual({ kind: "fpv", droneId: null });
    expect(flightModeState("orbit")).toEqual({ kind: "orbit", droneId: null });
  });
});
