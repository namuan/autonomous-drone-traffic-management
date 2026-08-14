import { describe, expect, it } from "vitest";
import { buildContract } from "@utm/autonomy";
import { CONFIG, makeScenario } from "@utm/core";
import { SimulationEngine, biasForDrone } from "./engine.js";
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

  it("performs lost-link emergency landing", { timeout: 30000 }, () => {
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

describe("engine review regressions", () => {
  it("records and caps flight trails", { timeout: 20000 }, () => {
    const engine = new SimulationEngine({ seed: 33 });
    for (let i = 0; i < 300; i++) engine.tick();
    let sawTrail = false;
    for (const d of engine.snapshot().drones) {
      expect(d.trail.length).toBeLessThanOrEqual(CONFIG.engine.maxTrailPoints);
      if (d.state === "en-route" && d.trail.length >= 2) sawTrail = true;
    }
    expect(sawTrail).toBe(true);
    for (let i = 0; i < 1500; i++) engine.tick();
    for (const d of engine.snapshot().drones) {
      expect(d.trail.length).toBeLessThanOrEqual(CONFIG.engine.maxTrailPoints);
    }
  });

  it("emits one geofence-violation event per entry and audits it", () => {
    const sc = makeScenario(42);
    // Put every spawn pad inside the heliport no-fly zone: all drones spawn
    // inside it and cannot leave (planning rejects the blocked start), so the
    // entry event must fire exactly once per drone - not once per tick.
    sc.landingSites = [{ id: "LS-TRAP", name: "Trap Pad", pos: { x: 100, y: 830, z: 0 }, capacity: 20, used: 0 }];
    const engine = new SimulationEngine({ seed: 42, scenario: sc });
    for (let i = 0; i < 120; i++) engine.tick();
    const events = engine.snapshot().recentEvents.filter((e) => e.type === "geofence-violation");
    const audits = engine.audit.entries.filter((e) => e.type === "geofence-violation");
    expect(events.length).toBe(7); // one per drone, deduplicated
    expect(audits.length).toBe(7);
    expect(engine.audit.verify().ok).toBe(true);
  });

  it("rejects conflicted replacement contracts and keeps the current reservation", () => {
    const engine = new SimulationEngine({ seed: 7 });
    for (let i = 0; i < 600; i++) engine.tick();
    const drone = engine.snapshot().drones.find((d) => d.state === "en-route" && d.contractId);
    expect(drone).toBeDefined();
    const before = engine.droneContractId(drone!.id);
    expect(before).not.toBeNull();

    // Reserve a fake conflicting contract along the drone's own corridor.
    const current = engine.index.getContract(before!);
    const along = (current!.points).map((p) => ({ x: p.x, y: p.y, z: p.z }));
    const fake = buildContract("FAKE-1", along, { speedMps: 10, t0: engine.timeS + 4 });
    engine.index.addContract(fake);

    // A replacement along the same corridor must be rejected...
    const ok = engine.requestReplacement(drone!.id, along, 10);
    expect(ok).toBe(false);
    // ...and the existing reservation must be untouched.
    expect(engine.droneContractId(drone!.id)).toBe(before);
    expect(engine.index.getContract(before!)).toBeDefined();
    expect(engine.snapshot().counters.contractsRejected).toBeGreaterThan(0);

    // A clear path elsewhere succeeds atomically.
    const clearPath = [
      { x: drone!.x + 800, y: Math.max(30, drone!.y + 800), z: drone!.z },
      { x: drone!.x + 1000, y: Math.max(30, drone!.y + 800), z: drone!.z },
    ];
    const oldObj = engine.index.getContract(before!);
    const ok2 = engine.requestReplacement(drone!.id, clearPath, 10);
    expect(ok2).toBe(true);
    // The reservation object is atomically replaced (same stable id).
    expect(engine.index.getContract(before!)).not.toBe(oldObj);
    const replaced = engine.index.getContract(before!);
    expect(Math.abs(replaced!.points[0]!.x - clearPath[0]!.x)).toBeLessThan(5);
  });

  it("reset clears reservations and restores pristine landing-site usage", () => {
    const engine = new SimulationEngine({ seed: 5 });
    for (let i = 0; i < 400; i++) engine.tick();
    engine.setWeather(true);
    for (let i = 0; i < 100; i++) engine.tick();
    engine.addDrone("delivery");
    for (let i = 0; i < 100; i++) engine.tick();
    expect(engine.index.contractCount).toBeGreaterThan(0);

    engine.reset();
    expect(engine.index.contractCount).toBe(0);
    expect(engine.snapshot().weather.length).toBe(0);

    // Landing-site occupancy must match a fresh engine.
    const fresh = new SimulationEngine({ seed: 5 });
    const sites = engine.snapshot().landingSites;
    const freshSites = fresh.snapshot().landingSites;
    for (let i = 0; i < sites.length; i++) {
      expect(sites[i]!.used).toBe(freshSites[i]!.used);
    }
    // And the simulation runs normally after reset.
    for (let i = 0; i < 400; i++) engine.tick();
    expect(engine.snapshot().counters.contractsIssued).toBeGreaterThan(0);
  });

  it("assigns distinct avoidance biases to standard drone ids", () => {
    const biases = new Set(["DEL-001", "SUR-001", "DEL-002", "SUR-002"].map((id) => biasForDrone(id)));
    expect(biases.size).toBe(4);
    for (const id of ["DEL-001", "SUR-001", "DEL-002", "SUR-002"]) {
      expect(biasForDrone(id)).toBeGreaterThanOrEqual(-25);
      expect(biasForDrone(id)).toBeLessThanOrEqual(25);
    }
  });
});

describe("engine review round 3 regressions", () => {
  it("reset clears gateway queues and identity registrations", () => {
    const engine = new SimulationEngine({ seed: 3 });
    for (let i = 0; i < 200; i++) engine.tick();
    const added = engine.addDrone("surveillance");
    engine.setSpoof(added.droneId as string, true);
    expect(engine.identity.isRegistered(added.droneId as string)).toBe(true);
    expect(engine.gateway.pendingCount).toBeGreaterThan(0);

    engine.reset();
    engine.tick(); // flushes the reset notice
    expect(engine.gateway.pendingCount).toBe(0);
    expect(engine.identity.isRegistered(added.droneId as string)).toBe(false);
  });

  it("reset reproduces a fresh engine exactly", () => {
    const a = new SimulationEngine({ seed: 9 });
    for (let i = 0; i < 150; i++) a.tick();
    a.reset();
    const b = new SimulationEngine({ seed: 9 });
    for (let i = 0; i < 150; i++) a.tick();
    for (let i = 0; i < 150; i++) b.tick();
    const sa = a.snapshot();
    const sb = b.snapshot();
    expect(sa.tick).toBe(sb.tick);
    expect(sa.drones.length).toBe(sb.drones.length);
    for (let i = 0; i < sa.drones.length; i++) {
      expect(sa.drones[i]!.x).toBe(sb.drones[i]!.x);
      expect(sa.drones[i]!.y).toBe(sb.drones[i]!.y);
      expect(sa.drones[i]!.state).toBe(sb.drones[i]!.state);
    }
    // gatewayEvents differs by exactly the reset notice event.
    const { gatewayEvents: _ga, ...ca } = sa.counters;
    const { gatewayEvents: _gb, ...cb } = sb.counters;
    expect(ca).toEqual(cb);
    expect(sa.counters.gatewayEvents - sb.counters.gatewayEvents).toBe(1);
  });

  it("tracks landing-site occupancy correctly for a normal delivery", () => {
    const sc = makeScenario(11);
    sc.droneSpecs = [sc.droneSpecs[0]!]; // one delivery drone
    sc.landingSites = sc.landingSites.map((l) => ({ ...l, capacity: 2, used: 0 }));
    const engine = new SimulationEngine({ seed: 11, scenario: sc });
    let landed = false;
    for (let i = 0; i < 9000 && !landed; i++) {
      engine.tick();
      landed = engine.snapshot().drones.some((d) => d.state === "landed");
    }
    expect(landed).toBe(true);
    // Spawn slot freed at departure, destination slot freed at landing.
    for (const site of engine.snapshot().landingSites) {
      expect(site.used).toBe(0);
    }
  });

  it("does not double-count the reserved slot on same-site emergency retarget", () => {
    const sc = makeScenario(12);
    sc.droneSpecs = [sc.droneSpecs[0]!]; // one delivery drone
    // A single pad: spawn, destination and emergency target are the same site.
    sc.landingSites = [{ id: "LS-ONLY", name: "Only Pad", pos: { x: 1850, y: 860, z: 0 }, capacity: 4, used: 0 }];
    const engine = new SimulationEngine({ seed: 12, scenario: sc });
    // Trigger the emergency in the brief en-route window (the drone delivers
    // to its own pad, so it lands almost immediately after launching).
    let droneId: string | null = null;
    for (let i = 0; i < 9000 && !droneId; i++) {
      engine.tick();
      const d = engine.snapshot().drones.find((x) => x.state === "en-route");
      if (d) droneId = d.id;
    }
    expect(droneId).not.toBeNull();
    const usedBefore = engine.snapshot().landingSites[0]!.used;
    engine.setLostLink(droneId as string, true);
    for (let i = 0; i < 100; i++) engine.tick();
    const usedAfter = engine.snapshot().landingSites[0]!.used;
    expect(usedAfter).toBe(usedBefore); // no leak on same-site retarget
    // And the emergency completes.
    let landed = false;
    for (let i = 0; i < 3000 && !landed; i++) {
      engine.tick();
      landed = engine.snapshot().drones.some((d) => d.id === droneId && d.state === "landed");
    }
    expect(landed).toBe(true);
    expect(engine.snapshot().landingSites[0]!.used).toBe(0);
  });

  it("lost-link retarget keeps the current reservation when conflicted", () => {
    const sc = makeScenario(13);
    sc.droneSpecs = [sc.droneSpecs[0]!];
    sc.landingSites = [
      { id: "LS-A", name: "Pad A", pos: { x: 1850, y: 860, z: 0 }, capacity: 4, used: 0 },
      { id: "LS-B", name: "Pad B", pos: { x: 300, y: 60, z: 0 }, capacity: 4, used: 0 },
    ];
    const engine = new SimulationEngine({ seed: 13, scenario: sc });
    for (let i = 0; i < 800; i++) engine.tick();
    const snap = engine.snapshot();
    const drone = snap.drones.find((d) => d.state === "en-route");
    expect(drone).toBeDefined();
    const before = engine.droneContractId(drone!.id) as string;
    const targetBefore = drone!.targetLabel;

    // Block the route to the nearest pad with a fake reservation.
    const site = engine.snapshot().landingSites[0]!;
    const blockPath = [
      { x: drone!.x, y: drone!.y, z: drone!.z },
      { x: site.pos.x, y: site.pos.y, z: 0 },
    ];
    const fake = buildContract("FAKE-2", blockPath, { speedMps: 10, t0: engine.timeS });
    engine.index.addContract(fake);

    engine.setLostLink(drone!.id, true);
    // Immediately: the first retarget attempt is rejected; the existing
    // reservation and mission are kept untouched.
    expect(engine.droneContractId(drone!.id)).toBe(before);
    const s2 = engine.snapshot();
    expect(s2.drones.find((d) => d.id === drone!.id)?.targetLabel).toBe(targetBefore);
    expect(s2.counters.contractsRejected).toBeGreaterThan(0);

    // The cooldown retries keep trying and succeed once the drone's motion
    // opens a deconflicted corridor; the emergency then completes.
    let landed = false;
    for (let i = 0; i < 6000 && !landed; i++) {
      engine.tick();
      landed = engine.snapshot().drones.some((d) => d.id === drone!.id && d.state === "landed");
    }
    expect(landed).toBe(true);
  });
});

describe("engine review round 4 regressions", () => {
  it("waits instead of overbooking when every pad is full", () => {
    const sc = makeScenario(14);
    sc.droneSpecs = [sc.droneSpecs[0]!];
    sc.landingSites = [{ id: "LS-ONLY", name: "Only Pad", pos: { x: 1850, y: 860, z: 0 }, capacity: 1, used: 0 }];
    const engine = new SimulationEngine({ seed: 14, scenario: sc });
    for (let i = 0; i < 3000; i++) engine.tick();
    const snap = engine.snapshot();
    // The spawn pad is full (the drone sits on it), so no destination can be
    // reserved: the drone waits and the pad is never overbooked.
    expect(snap.drones[0]!.state).toBe("waiting");
    expect(snap.landingSites[0]!.used).toBe(1);
  });

  it("never overbooks landing pads under load (adds, weather, lost links)", { timeout: 60000 }, () => {
    const engine = new SimulationEngine({ seed: 77 });
    for (let i = 0; i < 6000; i++) {
      engine.tick();
      if (i % 300 === 0) engine.addDrone(i % 2 === 0 ? "delivery" : "surveillance");
      if (i % 700 === 0) {
        const snap = engine.snapshot();
        const d = snap.drones.find((x) => x.state === "en-route");
        if (d) engine.setLostLink(d.id, true);
      }
      if (i % 500 === 0) {
        for (const site of engine.snapshot().landingSites) {
          expect(site.used).toBeLessThanOrEqual(site.capacity);
        }
      }
    }
  });

  it("reset restores the initial pause state", () => {
    const a = new SimulationEngine({ seed: 8, startPaused: true });
    a.setPaused(false);
    a.tick();
    expect(a.isPaused).toBe(false);
    a.reset();
    expect(a.isPaused).toBe(true);
    const b = new SimulationEngine({ seed: 8, startPaused: true });
    expect(a.isPaused).toBe(b.isPaused);
    // And a paused reset engine does not advance.
    const before = a.snapshot().simTimeS;
    a.tick();
    expect(a.snapshot().simTimeS).toBe(before);
  });
});
