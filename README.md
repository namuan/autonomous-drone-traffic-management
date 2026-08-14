# Autonomous Drone Traffic Management (UTM) — Sector A1

A runnable, simulation-only implementation of the UTM system described in
[PLAN.md](./PLAN.md). The monorepo builds a sector operations console: a
deterministic flight orchestrator with RRT\*/A\* planning, 4D trajectory
contracts, a sensor-fusion mesh with trust scoring, MPC + velocity-obstacle
tactical deconfliction, a priority event gateway, a 4D spatiotemporal index,
Ed25519 drone identity, and a tamper-evident audit chain — all visualized in
a live web console.

> **This is a simulation for education and demonstration. It is not
> airworthiness software.** See [docs/safety-scope.md](./docs/safety-scope.md)
> for exactly what is and is not claimed.

## Quick start

Requires Node.js >= 20 and pnpm (10+).

```bash
pnpm install
pnpm dev          # builds packages, starts API (:8787) + web console (:5173)
```

Open http://localhost:5173 .

Single-process production mode:

```bash
pnpm build
pnpm start        # serves API + built web console on http://localhost:8787
```

Quality gates:

```bash
pnpm check        # build + typecheck + lint + unit/integration tests
pnpm e2e          # browser smoke test (Playwright/Chromium) against a live server
```

## Monorepo layout

```
apps/
  api/        Fastify server: REST commands + WebSocket stream, owns the engine
  web/        React + Vite operations console (Canvas sector view)
packages/
  core/       Domain types, geometry, config, seeded RNG, wire schema, scenario
  autonomy/   RRT*, A*, 4D contracts, Kalman fusion, MPC, velocity obstacles
  runtime/    Simulation engine, priority gateway, 4D index, identity, audit
docs/
  architecture.md   Module boundaries, data flow, production-adapter map
  safety-scope.md   What is simulated vs. certified; limitations
scripts/
  smoke.mjs   Browser smoke test (pnpm e2e)
```

Dependency direction: `core -> autonomy -> runtime -> apps`.

## What the console shows

- Sector A1 (2000 x 1000 m), no-fly geofences, landing pads, grid at 100 m
- Pulsing turbulence cells from the "simulate weather" control; drones reroute
- Delivery (cyan) and surveillance (violet) drones with fading trails,
  planned routes, 18 m detection rings and 80 m mesh links
- State rings: red = critical battery, orange dashed = untrusted,
  gray = lost link, yellow = rerouting
- Live counters, priority-ordered gateway event feed, 4D airspace query tool,
  and per-drone inspection (fusion trust per sensor source, contract
  conformance, battery)
- Keyboard: `Space` pause · `W` weather · `D`/`V` add drone · `R` reset ·
  `Esc` deselect

## Verification

- Unit tests: geometry, deterministic RNG, RRT\*/A\* obstacle avoidance,
  4D contract conflict detection, Kalman trust degradation under spoofing,
  MPC/VO separation, gateway priority ordering, time-cube queries, Ed25519
  identity, audit-chain tamper detection, engine determinism and mission
  completion.
- Integration tests: REST commands mutate server state; WebSocket delivers
  snapshots and events; the 4D query endpoint returns contract + telemetry
  matches.
- Browser smoke test (`pnpm e2e`): real Chromium loads the console, connects
  the stream, runs commands and queries, and asserts zero console errors.
