# Architecture

This document describes how the implementation maps to the six pillars of
PLAN.md and where production infrastructure would replace simulation
adapters. It is written for engineers evaluating or extending the demo.

## Runtime model

The API server owns a single `SimulationEngine` and advances it on a fixed
100 ms tick (10 Hz). The browser is a pure console: it renders snapshots and
issues commands; it never runs simulation physics. This keeps client and
server state from diverging and makes scenarios reproducible — every engine
is seeded and all randomness flows through `SeededRandom` (mulberry32).

All coordinates are meters in a local sector frame (x: 0–2000, y: 0–1000,
z: 0–150). Pixels exist only in the renderer.

## Pillar mapping

### 1. Flight Orchestrator (`packages/autonomy` + `packages/runtime`)

- **RRT\*** (`rrt.ts`) — global planning around static geofences and weather
  cells, bounded iterations, seeded, with greedy shortcut smoothing and an
  exact goal termination fix.
- **A\*** (`astar.ts`) — tactical replanning on a 10 m grid for weather
  blocking, persistent non-conformance, and retargeting.
- **4D trajectory contracts** (`contracts.ts`) — time-sampled (x, y, z, t)
  polylines with horizontal/vertical tolerances (25 m / 10 m demo tubes);
  `contractsConflict` performs strategic deconfliction at planning time
  against the reservation index. Replacement contracts (reroutes,
  retargeting, waypoint advances) are validated against the index too;
  conflicted replacements fly provisionally without a reservation and emit
  a `contract-rejected` event.
- **Departure sequencing** — a drone only launches when the pad area is
  clear; launches climb vertically to their altitude lane (40/55/70 m for
  delivery, 85/100/115 m for surveillance) before en-route flight.

### 2. Sensor Fusion Mesh (`fusion.ts`)

A bank of constant-velocity Kalman filters, one per source (ADS-B 1 Hz,
radar 10 Hz, optical 5 Hz, lidar 10 Hz, cellular 0.5 Hz), with configured
noise and dropout. Each source maintains an innovation-based trust score.
Cross-source divergence drives the spoofing policy from PLAN.md: warn beyond
15 m, flag untrusted after sustained divergence beyond 20 m, and switch the
primary source from ADS-B to optical. The fused state is an
accuracy-weighted blend of source estimates.

### 3. Collision Avoidance (`mpc.ts`, `vo.ts`)

- Layer 1 (strategic): contract-vs-index deconfliction before dispatch.
- Layer 2 (tactical): a receding-horizon controller scores discrete
  velocity/altitude candidates over a 4 s horizon against route deviation,
  lookahead-target distance, energy, weather and predicted neighbor
  positions, then applies the best first action.
- Layer 3 (emergency): velocity obstacles pick the velocity closest to
  preferred that is outside every collision cone; vertical separation of
  15 m counts as deconflicted. A per-drone rotation bias and a fast
  climb/descend escape (6 m/s) break mirror-symmetric deadlocks. A
  safety-breach counter records airborne pairs closer than 18 m
  horizontally and 15 m vertically.

Known limitation: the greedy controller guarantees clearance but can settle
into a safe parallel/convoy pattern instead of a clean crossing in
pathological head-on cases. In the full engine this is mitigated by altitude
lanes, departure sequencing and rerouting; it is not a safety guarantee.

### 4. Telemetry Gateway (`gateway.ts`)

In-memory priority queues (P0 emergency > P1 safety > P2 telemetry >
P3 logs) drained in strict priority order each tick and streamed over the
WebSocket. The REST surface (drones, weather, pause, reset, spoof, lost
link) mirrors the plan's command set.

### 5. Spatiotemporal Database (`index4d.ts`)

In-memory store of active contracts plus a ring of recorded telemetry.
Answers "which drones pass through this cube during this window" for both
planned (contract) and past (telemetry) traffic, and backs the strategic
conflict check. The query is exposed over REST and in the console's query
tool.

### 6. Identity & Trust (`identity.ts`)

Every drone is registered to an operator with a real Ed25519 keypair
(node:crypto); heartbeats are signed and verified. Critical events
(launch, landing, breaches, untrusted flags, lost link, reroutes, geofence
violations) are appended to a SHA-256 hash chain; `verify()` recomputes the
chain and detects any tampering.

## Data flow

```
engine tick (100 ms)
  -> fusion observes true state through sensor models
  -> orchestrator: contracts, conformance, weather, battery
  -> MPC/VO control, physics integration
  -> mesh links, separation checks, trail + telemetry recording
  -> gateway flush (priority ordered) -> audit chain for critical events
  -> snapshot broadcast over WebSocket
web console: render snapshot + accept commands (REST) -> next tick
```

## Production adapter map

| Pillar | Simulation adapter | Production replacement |
| --- | --- | --- |
| Telemetry gateway | `PriorityGateway` | MQTT broker (QoS 1) / BEAM cluster, 50k connections, <20 ms latency |
| Spatiotemporal store | `SpacetimeIndex` | PostGIS + TimescaleDB + octree 4D index, retention policies |
| Identity | local Ed25519 registry | ASTM F3411 Remote ID, PKI registry, blockchain anchoring |
| Fusion | synthetic sensor models | real ADS-B/radar/lidar feeds, hardware-in-the-loop |
| Orchestrator | single in-process engine | sharded orchestrators per sector, hot standby, C-Link handoffs |

Latency, throughput and safety-probability figures from PLAN.md are design
targets of the real system, not properties of this simulation. Nothing here
should be measured or reported as if it were.
