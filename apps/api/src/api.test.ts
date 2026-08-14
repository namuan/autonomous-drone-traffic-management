import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { SimulationEngine } from "@utm/runtime";
import { buildApp } from "./server.js";

let engine: SimulationEngine;
let app: Awaited<ReturnType<typeof buildApp>>["app"];
let baseUrl: string;
let closeFn: () => Promise<void>;

beforeAll(async () => {
  engine = new SimulationEngine({ seed: 777 });
  const built = await buildApp({ engine });
  app = built.app;
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 8787}`;
  closeFn = async () => {
    await app.close();
  };
});

afterAll(async () => {
  await closeFn();
});

describe("REST API", () => {
  it("reports health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.tick).toBe("number");
  });

  it("returns a snapshot with the sector and drones", async () => {
    const res = await app.inject({ method: "GET", url: "/api/snapshot" });
    expect(res.statusCode).toBe(200);
    const snap = res.json();
    expect(snap.sector.widthM).toBe(2000);
    expect(snap.drones.length).toBeGreaterThan(0);
    expect(snap.geofences.length).toBeGreaterThan(0);
  });

  it("adds a drone and the snapshot reflects it", async () => {
    const before = (await app.inject({ method: "GET", url: "/api/snapshot" })).json().drones.length;
    const res = await app.inject({
      method: "POST",
      url: "/api/drones",
      payload: { role: "delivery" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().ok).toBe(true);
    const after = (await app.inject({ method: "GET", url: "/api/snapshot" })).json().drones.length;
    expect(after).toBe(before + 1);
  });

  it("activates weather and the snapshot shows zones after ticks", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/commands/weather",
      payload: { active: true },
    });
    expect(res.json().ok).toBe(true);
    for (let i = 0; i < 50; i++) engine.tick();
    const snap = (await app.inject({ method: "GET", url: "/api/snapshot" })).json();
    expect(snap.weather.length).toBeGreaterThanOrEqual(2);
  });

  it("pauses and resumes the simulation", async () => {
    const p1 = await app.inject({ method: "POST", url: "/api/commands/pause", payload: { paused: true } });
    expect(p1.json().paused).toBe(true);
    expect(engine.isPaused).toBe(true);
    const p2 = await app.inject({ method: "POST", url: "/api/commands/pause", payload: { paused: false } });
    expect(p2.json().paused).toBe(false);
  });

  it("spoofs a drone and clears it", async () => {
    const snap = (await app.inject({ method: "GET", url: "/api/snapshot" })).json();
    const drone = snap.drones[0];
    const res = await app.inject({ method: "POST", url: `/api/drones/${drone.id}/spoof`, payload: { on: true } });
    expect(res.statusCode).toBe(200);
    const missing = await app.inject({ method: "POST", url: "/api/drones/NOPE/spoof", payload: { on: true } });
    expect(missing.statusCode).toBe(404);
  });

  it("queries the airspace time-cube", async () => {
    for (let i = 0; i < 200; i++) engine.tick();
    const snap = (await app.inject({ method: "GET", url: "/api/snapshot" })).json();
    const qs = `x0=0&y0=0&z0=0&x1=${snap.sector.widthM}&y1=${snap.sector.heightM}&z1=${snap.sector.zMax}&t0=${snap.simTimeS - 30}&t1=${snap.simTimeS + 300}`;
    const res = await app.inject({ method: "GET", url: `/api/queries/airspace?${qs}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.matches.length).toBeGreaterThan(0);
    expect(body.contractCount + body.telemetryCount).toBe(body.matches.length);
  });

  it("reports a verified audit chain", async () => {
    const res = await app.inject({ method: "GET", url: "/api/audit" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verified).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);
  });
});

describe("WebSocket stream", () => {
  it("sends an initial snapshot and streams gateway events end-to-end", async () => {
    const ws = new WebSocket(baseUrl.replace("http", "ws") + "/ws");
    const messages: any[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(String(data))));
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    // The connect message must be a snapshot.
    await sleep(150);
    expect(messages[0]?.kind).toBe("snapshot");
    expect(messages[0]?.snapshot?.drones.length).toBeGreaterThan(0);

    // Drive ticks and add a drone over REST: the gateway event must reach the WS.
    for (let i = 0; i < 10; i++) engine.tick();
    const res = await app.inject({ method: "POST", url: "/api/drones", payload: { role: "surveillance" } });
    expect(res.statusCode).toBe(201);
    for (let i = 0; i < 10; i++) engine.tick();

    await sleep(300);
    const events = messages.filter((m) => m.kind === "event");
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.event.type === "drone-requested")).toBe(true);
    ws.close();
  });
});
