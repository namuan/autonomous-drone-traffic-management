/**
 * UTM API: Fastify server hosting one SimulationEngine.
 * REST endpoints for commands + queries, WebSocket for snapshot/event stream.
 * The engine ticks on a fixed 100 ms interval; clients receive snapshots at
 * the same rate and events in gateway priority order.
 */

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { SimulationEngine } from "@utm/runtime";
import type { AuditStateView, ClientCommand, DroneRole, WsMessage } from "@utm/core";

export interface ApiOptions {
  engine?: SimulationEngine;
  webDist?: string;
  tickMs?: number;
}

export async function buildApp(opts: ApiOptions = {}) {
  const engine = opts.engine ?? new SimulationEngine();
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });
  await app.register(websocket);

  // ------------------------------------------------------------- REST routes

  app.get("/health", async () => ({
    status: "ok",
    tick: engine.tickCount,
    simTimeS: Math.round(engine.timeS * 10) / 10,
    paused: engine.isPaused,
    drones: engine.droneCount,
  }));

  app.get("/api/snapshot", async () => engine.snapshot());

  app.get("/api/events", async () => engine.snapshot().recentEvents);

  app.get("/api/audit", async (): Promise<AuditStateView> => {
    const verified = engine.audit.verify();
    return {
      verified: verified.ok,
      entries: engine.audit.entries.map((e) => ({
        seq: e.seq,
        ts: Math.round(e.ts * 10) / 10,
        type: e.type,
        droneId: e.droneId,
        hash: e.hash.slice(0, 16),
        prevHash: e.prevHash === "genesis" ? "genesis" : e.prevHash.slice(0, 16),
      })),
      head: engine.audit.head.slice(0, 16),
    };
  });

  app.post("/api/drones", async (req, reply) => {
    const body = (req.body ?? {}) as { role?: string };
    const role: DroneRole = body.role === "surveillance" ? "surveillance" : "delivery";
    const res = engine.addDrone(role);
    if (!res.ok) return reply.code(409).send(res);
    return reply.code(201).send(res);
  });

  app.post("/api/commands/pause", async (req) => {
    const body = (req.body ?? {}) as { paused?: boolean };
    engine.setPaused(body.paused ?? false);
    return { ok: true, paused: engine.isPaused };
  });

  app.post("/api/commands/reset", async () => {
    engine.reset();
    return { ok: true };
  });

  app.post("/api/commands/weather", async (req) => {
    const body = (req.body ?? {}) as { active?: boolean; intensity?: number };
    engine.setWeather(body.active ?? false, body.intensity ?? 0.8);
    return { ok: true, active: body.active ?? false };
  });

  app.post("/api/drones/:id/spoof", async (req, reply) => {
    const body = (req.body ?? {}) as { on?: boolean };
    const res = engine.setSpoof((req.params as { id: string }).id, body.on ?? true);
    if (!res.ok) return reply.code(404).send(res);
    return res;
  });

  app.post("/api/drones/:id/lost-link", async (req, reply) => {
    const body = (req.body ?? {}) as { on?: boolean };
    const res = engine.setLostLink((req.params as { id: string }).id, body.on ?? true);
    if (!res.ok) return reply.code(404).send(res);
    return res;
  });

  app.get("/api/queries/airspace", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const num = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));
    return engine.queryAirspace({
      x0: num(q.x0, 0),
      y0: num(q.y0, 0),
      z0: num(q.z0, 0),
      x1: num(q.x1, 2000),
      y1: num(q.y1, 1000),
      z1: num(q.z1, 150),
      t0: num(q.t0, -60),
      t1: num(q.t1, 300),
    });
  });

  // ------------------------------------------------------------- WebSocket

  app.get("/ws", { websocket: true }, (socket) => {
    const send = (msg: WsMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    // Send the current state immediately on connect.
    send({ kind: "snapshot", snapshot: engine.snapshot() });
    const offEvents = engine.gateway.subscribe((event) => send({ kind: "event", event }));
    socket.on("message", (raw) => {
      try {
        const cmd = JSON.parse(String(raw)) as ClientCommand;
        void handleCommand(engine, cmd);
      } catch {
        send({ kind: "event", event: { id: 0, ts: engine.timeS, tick: engine.tickCount, priority: 3, type: "system", message: "Invalid command" } });
      }
    });
    socket.on("close", () => offEvents());
  });

  // ------------------------------------------------------------ static web

  const webDist = opts.webDist ?? process.env.WEB_DIST;
  if (webDist && existsSync(join(webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/" });
    app.setNotFoundHandler((_req, reply) => {
      reply.type("text/html").send(readFileSync(join(webDist, "index.html"), "utf8"));
    });
  }

  return { app, engine };
}

export function handleCommand(engine: SimulationEngine, cmd: ClientCommand): void {
  switch (cmd.type) {
    case "add-drone":
      engine.addDrone(cmd.role);
      break;
    case "weather":
      engine.setWeather(cmd.active, cmd.intensity ?? 0.8);
      break;
    case "pause":
      engine.setPaused(cmd.paused);
      break;
    case "reset":
      engine.reset();
      break;
    case "spoof":
      engine.setSpoof(cmd.droneId, cmd.on);
      break;
    case "lost-link":
      engine.setLostLink(cmd.droneId, cmd.on);
      break;
  }
}

export const EVENT_PRIORITY_LABEL: Record<number, string> = {
  0: "P0 emergency",
  1: "P1 safety",
  2: "P2 telemetry",
  3: "P3 log",
};

/** Start the production server (static web + API on one port). */
export async function startServer(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const webDist = process.env.WEB_DIST ?? join(process.cwd(), "..", "web", "dist");
  const { app, engine } = await buildApp({ webDist });
  const tickMs = 100;

  // Fixed-step engine loop; broadcasts snapshots at the simulation rate.
  setInterval(() => {
    engine.tick();
    const snapshot = engine.snapshot();
    const msg = JSON.stringify({ kind: "snapshot", snapshot } satisfies WsMessage);
    for (const conn of app.websocketServer?.clients ?? []) {
      if (conn.readyState === conn.OPEN) conn.send(msg);
    }
  }, tickMs);

  await app.listen({ port, host: "0.0.0.0" });
  console.log(`UTM API listening on http://localhost:${port} (sim ${tickMs}ms/tick, drones: ${engine.droneCount})`);
}

// Entry point: run the production server when executed directly.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("dist/server.js")) {
  startServer().catch((err) => {
    console.error("Failed to start UTM API:", err);
    process.exit(1);
  });
}
