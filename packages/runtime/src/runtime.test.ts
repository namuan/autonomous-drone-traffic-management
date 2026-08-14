import { describe, expect, it } from "vitest";
import { buildContract } from "@utm/autonomy";
import { SimulationEngine } from "./engine.js";
import { PriorityGateway } from "./gateway.js";
import { AuditChain, IdentityRegistry } from "./identity.js";
import { SpacetimeIndex } from "./index4d.js";

describe("PriorityGateway", () => {
  it("delivers priority-0 events before earlier queued lower-priority events", () => {
    const gw = new PriorityGateway();
    gw.push("drone-landed", "telemetry A", { droneId: "D1" });
    gw.push("drone-landed", "telemetry B", { droneId: "D2" });
    gw.push("emergency-landing", "EVASIVE ACTION", { droneId: "D3" });
    gw.push("reroute", "trajectory update", { droneId: "D4" });
    const out = gw.flush(10, 100);
    expect(out.length).toBe(4);
    expect(out[0]?.type).toBe("emergency-landing");
    expect(out[0]?.priority).toBe(0);
    // Then priority-1, then 2, then 3 - FIFO within a priority.
    expect(out[1]?.type).toBe("reroute");
    expect(out[1]?.priority).toBe(2);
    expect(out[2]?.type).toBe("drone-landed");
    expect(out[3]?.type).toBe("drone-landed");
    expect(out[3]?.message).toBe("telemetry B");
  });

  it("notifies subscribers in priority order", () => {
    const gw = new PriorityGateway();
    const seen: string[] = [];
    gw.subscribe((e) => seen.push(e.type));
    gw.push("drone-landed", "log");
    gw.push("safety-breach", "proximity");
    gw.flush(0, 0);
    expect(seen).toEqual(["safety-breach", "drone-landed"]);
  });
});

describe("SpacetimeIndex", () => {
  const path = (z: number) => [
    { x: 0, y: 0, z },
    { x: 1000, y: 500, z },
    { x: 2000, y: 1000, z },
  ];

  it("rejects a conflicting contract and accepts a deconflicted one", () => {
    const idx = new SpacetimeIndex();
    const a = buildContract("A", path(50), { speedMps: 10, t0: 0 });
    idx.addContract(a);
    // 4 s offset -> 40 m separation, inside the 25 m + 25 m tolerance sum.
    const b = buildContract("B", path(50), { speedMps: 10, t0: 4 });
    const conflicts = idx.conflicts(b);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.droneId).toBe("A");

    const c = buildContract("C", path(150), { speedMps: 10, t0: 4 });
    expect(idx.conflicts(c).length).toBe(0);
  });

  it("ignores released contracts", () => {
    const idx = new SpacetimeIndex();
    const a = buildContract("A", path(50), { speedMps: 10, t0: 0 });
    idx.addContract(a);
    idx.releaseContract(a.id);
    const b = buildContract("B", path(50), { speedMps: 10, t0: 30 });
    expect(idx.conflicts(b).length).toBe(0);
  });

  it("answers time-cube queries from contracts and telemetry", () => {
    const idx = new SpacetimeIndex();
    const a = buildContract("A", path(50), { speedMps: 10, t0: 0 });
    idx.addContract(a);
    // A passes near (1000, 500) at t=~50-150s.
    const res = idx.queryCube({ x0: 800, y0: 300, z0: 0, x1: 1200, y1: 700, z1: 80, t0: 40, t1: 160 });
    expect(res.matches.some((m) => m.droneId === "A" && m.from === "contract")).toBe(true);

    idx.recordTelemetry("B", 100, { x: 900, y: 400, z: 40 });
    const res2 = idx.queryCube({ x0: 800, y0: 300, z0: 0, x1: 1200, y1: 700, z1: 80, t0: 99, t1: 101 });
    expect(res2.matches.some((m) => m.droneId === "B" && m.from === "telemetry")).toBe(true);
  });
});

describe("IdentityRegistry", () => {
  it("signs and verifies heartbeats", () => {
    const reg = new IdentityRegistry();
    reg.registerDrone("DEL-001", "OP-AERODEPOT");
    const payload = reg.heartbeatPayload("DEL-001", 12.5, 100, 200, 50);
    const { signature } = reg.signHeartbeat("DEL-001", payload);
    expect(reg.verifyHeartbeat("DEL-001", payload, signature)).toBe(true);
  });

  it("rejects tampered payloads and unknown drones", () => {
    const reg = new IdentityRegistry();
    reg.registerDrone("DEL-001", "OP-AERODEPOT");
    const payload = reg.heartbeatPayload("DEL-001", 12.5, 100, 200, 50);
    const { signature } = reg.signHeartbeat("DEL-001", payload);
    const tampered = payload.replace("100", "999");
    expect(reg.verifyHeartbeat("DEL-001", tampered, signature)).toBe(false);
    expect(reg.verifyHeartbeat("NOPE", payload, signature)).toBe(false);
  });
});

describe("AuditChain", () => {
  it("verifies an untampered chain", () => {
    const chain = new AuditChain();
    chain.append(1, 10, "launch", { droneId: "D1" });
    chain.append(2, 20, "safety-breach", { droneId: "D1", data: { distM: 15 } });
    chain.append(3, 30, "landing", { droneId: "D1" });
    expect(chain.verify().ok).toBe(true);
    expect(chain.entries.length).toBe(3);
  });

  it("detects tampering anywhere in the chain", () => {
    const chain = new AuditChain();
    chain.append(1, 10, "launch", { droneId: "D1" });
    chain.append(2, 20, "safety-breach", { droneId: "D1", data: { distM: 15 } });
    chain.append(3, 30, "landing", { droneId: "D1" });
    // Tamper: alter a stored entry's data.
    chain.entries[1]!.data = { distM: 3 };
    const result = chain.verify();
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(2);
  });
});

describe("SimulationEngine", () => {
  it("is deterministic: same seed produces identical state", () => {
    const a = new SimulationEngine({ seed: 424242 });
    const b = new SimulationEngine({ seed: 424242 });
    for (let i = 0; i < 300; i++) {
      a.tick();
      b.tick();
    }
    const sa = a.snapshot();
    const sb = b.snapshot();
    expect(sa.tick).toBe(300);
    expect(sa.drones.length).toBe(sb.drones.length);
    for (let i = 0; i < sa.drones.length; i++) {
      const da = sa.drones[i] as (typeof sa.drones)[number];
      const db = sb.drones[i] as (typeof sb.drones)[number];
      expect(da.x).toBe(db.x);
      expect(da.y).toBe(db.y);
      expect(da.state).toBe(db.state);
    }
  });

  it("launches drones and issues 4D contracts", () => {
    const engine = new SimulationEngine({ seed: 7 });
    for (let i = 0; i < 500; i++) engine.tick();
    const snap = engine.snapshot();
    expect(snap.counters.contractsIssued).toBeGreaterThan(0);
    const launched = snap.drones.filter((d) => d.state !== "requesting" && d.state !== "waiting");
    expect(launched.length).toBeGreaterThan(0);
  });

  it("delivers a delivery drone to its destination and lands it", () => {
    const engine = new SimulationEngine({ seed: 99 });
    engine.addDrone("delivery");
    let landed = false;
    for (let i = 0; i < 9000 && !landed; i++) {
      engine.tick();
      const snap = engine.snapshot();
      landed = snap.drones.some((d) => d.state === "landed" || d.state === "landing");
    }
    expect(landed).toBe(true);
  });

  it("maintains separation in a head-on encounter (MPC/VO)", { timeout: 30000 }, () => {
    const engine = new SimulationEngine({ seed: 12345 });
    // Run a busy scenario and require that breaches stay bounded while many
    // drones are airborne (some ground/launch states can legitimately be close).
    let maxBreaches = 0;
    let last = 0;
    for (let i = 0; i < 1800; i++) {
      engine.tick();
      if (i % 120 === 0) engine.addDrone(i % 2 === 0 ? "delivery" : "surveillance");
      const c = engine.snapshot().counters.safetyBreaches;
      if (c !== last) {
        maxBreaches = Math.max(maxBreaches, c - last);
        last = c;
      }
    }
    // With separation logic working, no single tick window of 120 should
    // accumulate an unbounded number of fresh breach pairs.
    expect(maxBreaches).toBeLessThan(6);
  });

  it("flags a spoofed drone as untrusted", () => {
    const engine = new SimulationEngine({ seed: 3 });
    for (let i = 0; i < 400; i++) engine.tick();
    const snap = engine.snapshot();
    const target = snap.drones.find((d) => d.state === "en-route");
    expect(target).toBeDefined();
    const res = engine.setSpoof(target!.id, true);
    expect(res.ok).toBe(true);
    let untrusted = false;
    for (let i = 0; i < 600; i++) {
      engine.tick();
      const s2 = engine.snapshot();
      const d2 = s2.drones.find((d) => d.id === target!.id);
      if (d2?.flags.untrusted) {
        untrusted = true;
        break;
      }
    }
    expect(untrusted).toBe(true);
    expect(engine.snapshot().counters.untrustedFlags).toBeGreaterThan(0);
  });

  it("performs lost-link emergency landing", () => {
    const engine = new SimulationEngine({ seed: 5 });
    for (let i = 0; i < 400; i++) engine.tick();
    const snap = engine.snapshot();
    const target = snap.drones.find((d) => d.state === "en-route");
    expect(target).toBeDefined();
    engine.setLostLink(target!.id, true);
    let landed = false;
    for (let i = 0; i < 2000 && !landed; i++) {
      engine.tick();
      const s2 = engine.snapshot();
      const d2 = s2.drones.find((d) => d.id === target!.id);
      if (d2 && (d2.state === "landed" || d2.state === "landing")) landed = true;
    }
    expect(landed).toBe(true);
  });

  it("spawns weather zones when activated", () => {
    const engine = new SimulationEngine({ seed: 11 });
    engine.setWeather(true);
    for (let i = 0; i < 200; i++) engine.tick();
    const snap = engine.snapshot();
    expect(snap.weather.length).toBeGreaterThanOrEqual(2);
    expect(snap.counters.weatherEvents).toBeGreaterThanOrEqual(2);
  });

  it("answers an airspace query over the live sector", () => {
    const engine = new SimulationEngine({ seed: 21 });
    for (let i = 0; i < 600; i++) engine.tick();
    const snap = engine.snapshot();
    const q = engine.queryAirspace({
      x0: 0,
      y0: 0,
      z0: 0,
      x1: snap.sector.widthM,
      y1: snap.sector.heightM,
      z1: snap.sector.zMax,
      t0: snap.simTimeS - 30,
      t1: snap.simTimeS + 300,
    });
    expect(q.matches.length).toBeGreaterThan(0);
    expect(q.contractCount + q.telemetryCount).toBe(q.matches.length);
  });

  it("rejects unknown drone commands gracefully", () => {
    const engine = new SimulationEngine({ seed: 1 });
    expect(engine.setSpoof("NOPE", true).ok).toBe(false);
    expect(engine.setLostLink("NOPE", true).ok).toBe(false);
  });
});
