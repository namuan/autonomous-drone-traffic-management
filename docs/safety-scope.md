# Safety scope

This repository implements an educational simulation of an autonomous drone
traffic management system. It is not software for operating aircraft.

## What this is

- A deterministic, in-memory model of one urban sector, visualized in a web
  console.
- Working demonstrations of planning, deconfliction, fusion, trust, priority
  messaging, 4D queries, identity signatures and audit chains, all in a
  single-process simulation.

## What this is not

- **Not certified.** No SIL-4 (or any SIL) claim is made. The MPC and
  velocity-obstacle controllers are simplified discrete-candidate solvers,
  not verified control laws.
- **Not real sensing.** Sensor observations are synthetic (configured noise,
  dropout, spoof models) of the engine's true state. There is no GPS, radar,
  ADS-B hardware, or ASTM F3411 conformance.
- **Not a real database.** The 4D index is an in-memory adapter; there is no
  PostGIS, TimescaleDB, retention policy, or regulatory reporting.
- **Not a real network.** The gateway is an in-process priority queue; there
  is no MQTT, QoS 1, BEAM cluster, 50,000 connections, or sub-20 ms latency
  guarantee.
- **Not a real ledger.** The audit chain is a local SHA-256 hash chain, not
  a distributed blockchain anchor.
- **No safety guarantees.** Drones in the simulation can come closer than
  18 m (the breach counter records it); a real system would need far stricter
  assurance than this model provides. Weather cells, spoofing and lost links
  are scenario tools, not validated hazard models.

## Interpretation rules

- Thresholds (18 m separation, 15 m vertical, 15/20 m spoof, 30/15 m
  conformance, 25 m/10 m contract tolerances) are simulation parameters
  drawn from PLAN.md. They are not regulatory limits.
- The greedy MPC/VO controller maintains clearance in tests but can settle
  into a safe parallel/convoy pattern instead of a clean crossing in
  pathological head-on cases; the altitude lanes, departure sequencing and
  rerouting in the orchestrator mitigate this in practice. None of this is
  a safety assurance result.
- Latency, throughput, collision-probability and capacity figures in PLAN.md
  are design targets for production systems. Do not report measurements of
  this simulation as if they were those targets.

## If you are building a real UTM

Start with a safety case, airspace regulation, and certification
requirements; treat this codebase as a prototyping reference only.
