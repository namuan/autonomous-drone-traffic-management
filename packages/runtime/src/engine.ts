/**
 * SimulationEngine: the sector orchestrator (Flight Orchestrator pillar).
 * Owns the deterministic fixed-step simulation clock, drones, weather,
 * contracts, the 4D reservation index, fusion, tactical control and the
 * priority gateway. The API server hosts one engine and streams snapshots.
 *
 * Explicitly a simulation: no real aircraft, no certified safety claims.
 */

import {
  CONFIG,
  type AirspaceQuery,
  type AirspaceQueryResult,
  type Counters,
  type DroneRole,
  type DroneSpec,
  type DroneState,
  type LandingSite,
  type MeshLink,
  type Obstacle,
  type Point3,
  type Snapshot,
  type SystemEvent,
  type WeatherZone,
  type DroneView,
  SeededRandom,
  dist2,
  dist3,
  pointBlocked,
  pointInRect,
  segmentCircleIntersect,
  defaultScenario,
  type Scenario,
} from "@utm/core";
import {
  DroneFusion,
  buildContract,
  computeControl,
  contractPointAt,
  deviationFromContract,
  planAStar,
  planRrt,
  withVerticalProfile,
  type NeighborPrediction,
} from "@utm/autonomy";
import { AuditChain, IdentityRegistry } from "./identity.js";
import { PriorityGateway } from "./gateway.js";
import { SpacetimeIndex } from "./index4d.js";

interface InternalDrone {
  spec: DroneSpec;
  state: DroneState;
  flags: { untrusted: boolean; lostLink: boolean; criticalBattery: boolean };
  /** Geofence id the drone is currently inside, or null. */
  insideGeofence: string | null;
  pos: Point3;
  vel: Point3;
  batteryWh: number;
  fusion: DroneFusion;
  rng: SeededRandom;
  contractId: string | null;
  mission: { waypoints: Point3[]; waypointIndex: number; cruiseSpeed: number; maxSpeed: number; home: Point3 } | null;
  launchUntilS: number | null;
  conformanceState: "conforming" | "warning" | "deviating";
  conformanceSinceS: number | null;
  route: Point3[]; // current planned path (remaining, includes current pos at index 0)
  trail: Point3[];
  spoofOn: boolean;
  lostLinkSinceS: number | null;
  untrustedSinceS: number | null;
  waitUntilS: number;
  /** Pad the drone spawned from; the slot is freed at departure. */
  spawnSiteId: string | null;
  /** Landing slot reserved for this flight; freed at landing. */
  reservedSiteId: string | null;
  controlMode: "mpc" | "vo";
  targetLabel: string;
  lastBreachCheckS: number;
  removeAtS: number | null;
  rerouteRetryAtS: number;
  legRetryAtS: number;
  retargetRetryAtS: number;
  /** Lost-link emergency contract successfully installed. */
  lostLinkTargeted: boolean;
}

export interface EngineOptions {
  seed?: number;
  scenario?: Scenario;
  startPaused?: boolean;
  tickMs?: number;
}

export class SimulationEngine {
  readonly seed: number;
  private originalScenario: Scenario;
  private scenario: Scenario;
  private rng: SeededRandom;
  private weatherRng: SeededRandom;
  private tickCounter = 0;
  private simTimeS = 0;
  private paused: boolean;
  private tickMs: number;

  private drones = new Map<string, InternalDrone>();
  private contracts = new Map<string, ReturnType<typeof buildContract>>();
  private weather: WeatherZone[] = [];
  private weatherActive = false;
  private weatherIntensity = 0.8;
  private weatherNextSpawnS = 10;

  readonly gateway = new PriorityGateway();
  readonly index = new SpacetimeIndex();
  readonly audit = new AuditChain();
  readonly identity = new IdentityRegistry();

  private counters: Counters = this.zeroCounters();
  private recentEvents: SystemEvent[] = [];
  private meshLinks: MeshLink[] = [];
  private breachCooldown = new Map<string, number>();
  private droneSerial = 1;
  private weatherSerial = 0;

  constructor(opts: EngineOptions = {}) {
    this.seed = opts.seed ?? defaultScenario.seed;
    // Deep-copy the supplied scenario so later external mutation cannot leak
    // into reset behavior.
    this.originalScenario = makeScenarioCopy(opts.scenario ?? defaultScenario);
    this.scenario = makeScenarioCopy(this.originalScenario);
    this.rng = new SeededRandom(this.seed);
    this.weatherRng = this.rng.branch(0x5eed);
    this.paused = opts.startPaused ?? false;
    this.tickMs = opts.tickMs ?? CONFIG.engine.tickMs;
    this.init();
  }

  private zeroCounters(): Counters {
    return {
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
    };
  }

  private init(): void {
    this.drones.clear();
    this.contracts.clear();
    this.weather = [];
    this.weatherActive = false;
    this.weatherIntensity = 0.8;
    this.weatherNextSpawnS = 10;
    this.counters = this.zeroCounters();
    this.recentEvents = [];
    this.meshLinks = [];
    this.breachCooldown.clear();
    this.audit.clear();
    this.index.clear();
    this.gateway.clear();
    this.identity.clear();
    // Recreate the random streams so a reset reproduces a fresh engine
    // exactly (same seed -> same initial state and behavior).
    this.rng = new SeededRandom(this.seed);
    this.weatherRng = this.rng.branch(0x5eed);
    this.scenario = makeScenarioCopy(this.originalScenario); // pristine site usage
    this.droneSerial = 1;
    this.weatherSerial = 0;
    this.simTimeS = 0;
    this.tickCounter = 0;

    for (const spec of this.scenario.droneSpecs) {
      this.spawnDrone(spec, true);
    }
  }

  // ---------------------------------------------------------------- accessors

  get timeS(): number {
    return this.simTimeS;
  }

  get tickCount(): number {
    return this.tickCounter;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get droneCount(): number {
    return this.drones.size;
  }

  // ------------------------------------------------------------------- clock

  /** Advance one fixed step (100 ms). Returns events flushed this tick. */
  tick(): SystemEvent[] {
    if (this.paused) return [];
    this.tickCounter++;
    this.simTimeS = this.tickCounter * this.tickMs / 1000;
    const dt = this.tickMs / 1000;

    this.stepWeather(dt);
    for (const d of [...this.drones.values()]) this.stepDrone(d, dt);
    this.computeMeshLinks();
    this.checkSeparation();
    this.recordTelemetry();

    const events = this.gateway.flush(this.simTimeS, this.tickCounter);
    for (const e of events) {
      this.recentEvents.push(e);
      if (this.recentEvents.length > 60) this.recentEvents.shift();
    }
    this.counters.gatewayEvents += events.length;
    return events;
  }

  // ----------------------------------------------------------------- weather

  private stepWeather(dt: number): void {
    for (const wz of this.weather) {
      wz.ageSec += dt;
      wz.phase += (dt * 2 * Math.PI) / CONFIG.weather.expansionPeriodS;
      wz.radius = wz.baseRadius * (0.65 + 0.35 * Math.sin(wz.phase));
      wz.center.x += Math.sin(wz.phase * 0.7) * 0.15;
      wz.center.y += Math.cos(wz.phase * 0.5) * 0.15;
    }
    if (this.weather.length > 0) {
      this.weather = this.weather.filter((w) => w.ageSec < CONFIG.weather.lifetimeS);
    }
    if (!this.weatherActive) return;
    if (this.simTimeS >= this.weatherNextSpawnS && this.weather.length < CONFIG.weather.maxZones) {
      this.spawnWeatherZone();
      this.weatherNextSpawnS = this.simTimeS + CONFIG.weather.spawnEveryS;
    }
  }

  private spawnWeatherZone(): void {
    const rng = this.weatherRng;
    this.weatherSerial++;
    const baseRadius = rng.range(CONFIG.weather.minRadiusM, CONFIG.weather.maxRadiusM);
    this.weather.push({
      id: `WZ-${this.weatherSerial}`,
      center: {
        x: rng.range(baseRadius + 50, CONFIG.sector.widthM - baseRadius - 50),
        y: rng.range(baseRadius + 50, CONFIG.sector.heightM - baseRadius - 50),
        z: rng.range(30, 110),
      },
      baseRadius,
      radius: baseRadius,
      intensity: this.weatherIntensity * rng.range(0.7, 1.0),
      phase: rng.range(0, Math.PI * 2),
      ageSec: 0,
    });
    this.counters.weatherEvents++;
    this.gateway.push("weather-event", `Turbulence zone ${this.weather[this.weather.length - 1].id} formed`, {
      data: { radiusM: Math.round(baseRadius) },
    });
    this.auditAppend("weather-event", undefined, { zoneId: this.weather[this.weather.length - 1].id, radiusM: Math.round(baseRadius) });
  }

  // ----------------------------------------------------------------- drones

  private spawnDrone(spec: DroneSpec, initial: boolean): InternalDrone {
    const site = this.pickSpawnSite(spec.role, initial);
    const sitePos = site ? { x: site.pos.x, y: site.pos.y, z: 0 } : { x: 500, y: 500, z: 0 };
    const d: InternalDrone = {
      spec,
      state: "requesting",
      flags: { untrusted: false, lostLink: false, criticalBattery: false },
      insideGeofence: null,
      pos: sitePos,
      vel: { x: 0, y: 0, z: 0 },
      batteryWh: spec.batteryCapacityWh,
      fusion: new DroneFusion({ x: sitePos.x, y: sitePos.y, z: 0 }),
      rng: this.rng.branch(this.droneSerial * 7919),
      contractId: null,
      mission: null,
      launchUntilS: null,
      conformanceState: "conforming",
      conformanceSinceS: null,
      route: [],
      trail: [],
      spoofOn: false,
      lostLinkSinceS: null,
      untrustedSinceS: null,
      waitUntilS: initial ? this.simTimeS + this.rng.range(0, 25) : this.simTimeS + 1,
      spawnSiteId: site?.id ?? null,
      reservedSiteId: null,
      controlMode: "mpc",
      targetLabel: site ? `spawn: ${site.name}` : "spawn",
      lastBreachCheckS: 0,
      removeAtS: null,
      rerouteRetryAtS: 0,
      legRetryAtS: 0,
      retargetRetryAtS: 0,
      lostLinkTargeted: false,
    };
    this.droneSerial++;
    this.drones.set(spec.id, d);
    this.identity.registerDrone(spec.id, spec.role === "delivery" ? "OP-AERODEPOT" : "OP-NORTHLIFT");
    if (!initial) {
      this.gateway.push("drone-requested", `${spec.callsign} (${spec.role}) requested at ${site?.name ?? "pad"}`, {
        droneId: spec.id,
      });
    }
    return d;
  }

  private pickSpawnSite(role: DroneRole, initial: boolean): LandingSite | null {
    const sites = this.scenario.landingSites.filter((s) => s.used < s.capacity);
    if (sites.length === 0) return null;
    const preferred = role === "delivery" ? ["LS-DEPOT", "LS-SOUTH"] : ["LS-NORTH", "LS-RIVER"];
    const ordered = [...sites].sort((a, b) => {
      const ia = preferred.indexOf(a.id);
      const ib = preferred.indexOf(b.id);
      return (ia === -1 ? 9 : ia) - (ib === -1 ? 9 : ib);
    });
    const site = initial ? ordered[0] ?? sites[0] : this.rng.pick(ordered);
    if (site) site.used++;
    return site ?? null;
  }

  private stepDrone(d: InternalDrone, dt: number): void {
    // Battery decay.
    d.batteryWh = Math.max(0, d.batteryWh - (d.spec.batteryDrawW * dt) / 3600);
    const pct = (d.batteryWh / d.spec.batteryCapacityWh) * 100;
    if (!d.flags.criticalBattery && pct <= CONFIG.battery.criticalPct) {
      d.flags.criticalBattery = true;
      this.gateway.push("emergency-landing", `${d.spec.callsign} battery critical (${pct.toFixed(1)}%) - landing prioritized`, {
        droneId: d.spec.id,
        data: { batteryPct: Math.round(pct * 10) / 10 },
      });
      this.auditAppend("emergency-landing", d.spec.id, { batteryPct: Math.round(pct * 10) / 10 });
      if (d.state === "en-route" || d.state === "rerouting") {
        this.retargetToLanding(d);
      }
    }

    // Record the flight trail for the console renderer.
    if (this.tickCounter % CONFIG.engine.trailSampleEveryTicks === 0) {
      d.trail.push({ ...d.pos });
      if (d.trail.length > CONFIG.engine.maxTrailPoints) d.trail.shift();
    }

    if (d.state === "landed" || d.state === "removed") return;

    // Fusion: observe the true state through the sensor mesh.
    const fused = d.fusion.step(this.simTimeS, d.pos, d.rng);
    // Trust / spoofing detection: ADS-B vs radar divergence.
    if (d.spoofOn && fused.adsBvsRadarM > CONFIG.trust.spoofUntrustedM) {
      d.untrustedSinceS = d.untrustedSinceS === null ? this.simTimeS : d.untrustedSinceS;
      if (!d.flags.untrusted && this.simTimeS - d.untrustedSinceS > CONFIG.trust.untrustedPersistS) {
        d.flags.untrusted = true;
        this.counters.untrustedFlags++;
        this.gateway.push("untrusted-flagged", `${d.spec.callsign} flagged untrusted (ADS-B/radar divergence ${fused.adsBvsRadarM.toFixed(0)}m)`, {
          droneId: d.spec.id,
        });
        this.auditAppend("untrusted-flagged", d.spec.id, { divergenceM: Math.round(fused.adsBvsRadarM) });
      }
    } else {
      d.untrustedSinceS = null;
    }

    // Geofence violation check.
    this.checkGeofences(d);

    // Lost-link emergency retarget retries on cooldown until reserved.
    if (d.flags.lostLink && !d.lostLinkTargeted) {
      this.attemptLostLinkRetarget(d);
    }

    // State machine.
    switch (d.state) {
      case "requesting":
        this.stepRequesting(d);
        break;
      case "waiting":
        if (this.simTimeS >= d.waitUntilS) d.state = "requesting";
        break;
      case "launching":
        // Vertical takeoff: climb to the mission lane altitude at the pad,
        // then transition to en-route.
        {
          const lane = d.mission?.waypoints[0]?.z ?? (d.spec.zLanes[0] as number);
          if (d.pos.z < lane - 1) {
            d.vel = { x: 0, y: 0, z: 3.5 };
            d.pos.z = Math.min(lane, d.pos.z + 3.5 * dt);
          } else if (d.launchUntilS !== null && this.simTimeS >= d.launchUntilS) {
            d.state = "en-route";
            d.launchUntilS = null;
            d.vel = { x: 0, y: 0, z: 0 };
            this.releaseSpawnSlot(d);
          }
        }
        break;
      case "en-route":
      case "rerouting":
        this.stepEnRoute(d, dt, fused.pos);
        break;
      case "returning":
        this.stepEnRoute(d, dt, fused.pos);
        break;
      case "landing":
        this.stepLanding(d, dt);
        break;
    }
  }

  private stepRequesting(d: InternalDrone): void {
    // Departure sequencing: do not launch into a crowded pad area.
    for (const other of this.drones.values()) {
      if (other.spec.id === d.spec.id) continue;
      if (other.state === "landed" || other.state === "removed") continue;
      if (other.state === "requesting" || other.state === "waiting") continue;
      if (dist2(d.pos.x, d.pos.y, other.pos.x, other.pos.y) < 45 && Math.abs(d.pos.z - other.pos.z) < 30) {
        d.state = "waiting";
        d.waitUntilS = this.simTimeS + 4 + d.rng.range(0, 6);
        return;
      }
    }

    if (!d.mission) {
      this.assignMission(d);
      if (!d.mission) {
        d.state = "waiting";
        d.waitUntilS = this.simTimeS + 30;
        return;
      }
    }
    const goal = d.mission.waypoints[d.mission.waypointIndex] as Point3;
    const obstacles = this.currentObstacles();
    const start = { ...d.pos, z: d.spec.zLanes[0] as number };

    let path = planRrt(start, goal, obstacles, d.rng.branch(this.tickCounter % 97));
    if (!path) {
      path = planAStar(start, goal, obstacles);
    }
    if (!path || path.length < 2) {
      this.counters.contractsRejected++;
      d.state = "waiting";
      d.waitUntilS = this.simTimeS + 15;
      this.gateway.push("contract-rejected", `${d.spec.callsign}: no route to ${this.targetName(d)} - will retry`, { droneId: d.spec.id });
      return;
    }

    // Try altitude lanes until the contract clears the 4D reservation index.
    const climbTime = Math.max(0, ((d.spec.zLanes[0] as number) - d.pos.z) / 3.5);
    for (const laneZ of d.spec.zLanes) {
      const lanePath = path.map((p) => ({ ...p, z: laneZ }));
      const contract = buildContract(d.spec.id, lanePath, {
        speedMps: d.mission.cruiseSpeed,
        t0: this.simTimeS + CONFIG.launch.durationS + climbTime,
      });
      const conflicting = this.index.conflicts(contract, d.spec.id);
      if (conflicting.length === 0) {
        this.index.addContract(contract);
        this.contracts.set(contract.id, contract);
        d.contractId = contract.id;
        d.route = lanePath;
        d.state = "launching";
        d.launchUntilS = this.simTimeS + CONFIG.launch.durationS + climbTime;
        d.targetLabel = this.targetName(d);
        this.counters.contractsIssued++;
        this.gateway.push("contract-issued", `${d.spec.callsign}: 4D contract ${contract.id} at ${laneZ}m`, {
          droneId: d.spec.id,
          data: { laneM: laneZ, waypoints: lanePath.length },
        });
        this.auditAppend("contract-issued", d.spec.id, { laneM: laneZ });
        this.gateway.push("launch", `${d.spec.callsign} launching`, { droneId: d.spec.id });
        this.auditAppend("launch", d.spec.id, {});
        return;
      }
    }
    // All lanes conflicted: delay and retry.
    this.counters.contractsRejected++;
    d.state = "waiting";
    d.waitUntilS = this.simTimeS + 8 + d.rng.range(0, 12);
    this.gateway.push("contract-rejected", `${d.spec.callsign}: airspace busy - delayed ${Math.round(d.waitUntilS - this.simTimeS)}s`, {
      droneId: d.spec.id,
    });
  }

  private stepEnRoute(d: InternalDrone, dt: number, _fusedPos: Point3): void {
    const contract = d.contractId ? this.contracts.get(d.contractId) : undefined;
    const goal = d.mission?.waypoints[d.mission.waypointIndex] ?? null;

    // Weather blocking ahead -> tactical reroute (A*) with retry cooldown.
    if (this.weatherBlockingAhead(d) && d.state !== "rerouting" && this.simTimeS >= d.rerouteRetryAtS) {
      this.startReroute(d);
      return;
    }

    // Conformance monitoring (PLAN.md section 6): deviation vs the contract's
    // expected position and altitude at the current time.
    if (contract) {
      const dev = deviationFromContract(d.pos, contract, this.simTimeS);
      const over = dev.hM > CONFIG.conformance.horizontalM || dev.vM > CONFIG.conformance.verticalM;
      if (over) {
        d.conformanceState = "warning";
        d.conformanceSinceS = d.conformanceSinceS ?? this.simTimeS;
        if (this.simTimeS - d.conformanceSinceS > CONFIG.conformance.rerouteAfterS && d.state !== "rerouting") {
          this.counters.conformanceAlerts++;
          this.gateway.push("conformance-alert", `${d.spec.callsign} deviating (h ${dev.hM.toFixed(0)}m / v ${dev.vM.toFixed(0)}m) from contract - rerouting`, {
            droneId: d.spec.id,
            data: { hM: Math.round(dev.hM), vM: Math.round(dev.vM) },
          });
          this.auditAppend("conformance-alert", d.spec.id, { hM: Math.round(dev.hM), vM: Math.round(dev.vM) });
          this.startReroute(d);
          return;
        }
      } else {
        d.conformanceState = "conforming";
        d.conformanceSinceS = null;
      }
    }

    // Tactical control: MPC with VO fallback against mesh neighbors.
    // Altitude guidance comes from the contract's expected altitude; the
    // lookahead target (about one horizon ahead) keeps the drone on course.
    const expectedZ = contract ? contractPointAt(contract, this.simTimeS).z : goal?.z ?? d.pos.z;
    const target = contract ? contractPointAt(contract, this.simTimeS + 3.5) : goal;
    const route = this.routeForControl(d);
    const neighbors = this.meshNeighborsFor(d);
    const control = computeControl({
      pos: d.pos,
      vel: d.vel,
      cruiseSpeed: d.mission?.cruiseSpeed ?? d.spec.cruiseSpeed,
      maxSpeed: d.mission?.maxSpeed ?? d.spec.maxSpeed,
      laneZ: expectedZ,
      target: target ?? undefined,
      route,
      neighbors,
      weather: this.weather,
      biasDeg: biasForDrone(d.spec.id),
    });
    d.controlMode = control.mode;

    // The emergency landing contract is followed like any other contract
    // (no straight-line bypass): the replacement reservation was validated
    // against the 4D index before the mission changed.
    d.vel.x += (control.vx - d.vel.x) * Math.min(1, dt * 3);
    d.vel.y += (control.vy - d.vel.y) * Math.min(1, dt * 3);
    d.vel.z += (control.vz - d.vel.z) * Math.min(1, dt * 2);
    const speed = Math.hypot(d.vel.x, d.vel.y);
    const maxS = d.mission?.maxSpeed ?? d.spec.maxSpeed;
    if (speed > maxS) {
      d.vel.x *= maxS / speed;
      d.vel.y *= maxS / speed;
    }

    d.pos.x += d.vel.x * dt;
    d.pos.y += d.vel.y * dt;
    d.pos.z = Math.max(1, Math.min(CONFIG.sector.zMax, d.pos.z + d.vel.z * dt));

    // Arrival check.
    if (goal && dist2(d.pos.x, d.pos.y, goal.x, goal.y) < 20 && Math.abs(d.pos.z - goal.z) < 12) {
      const mission = d.mission;
      if (mission && mission.waypointIndex < mission.waypoints.length - 1 && this.simTimeS >= d.legRetryAtS) {
        const nextGoal = mission.waypoints[mission.waypointIndex + 1] as Point3;
        const obstacles = this.currentObstacles();
        const start = { ...d.pos, z: d.pos.z };
        const path = planAStar(start, nextGoal, obstacles) ?? planRrt(start, nextGoal, obstacles, d.rng.branch(this.tickCounter % 89));
        if (!path || path.length < 2) {
          d.legRetryAtS = this.simTimeS + 5;
          return;
        }
        // Atomic replacement: only advance the leg when the new contract
        // clears the index; otherwise loiter at the waypoint and retry.
        const replaced = this.requestReplacement(d.spec.id, path, mission.cruiseSpeed);
        if (!replaced) {
          d.legRetryAtS = this.simTimeS + 5;
          return;
        }
        mission.waypointIndex++;
        d.targetLabel = this.targetName(d);
        this.gateway.push("drone-requested", `${d.spec.callsign} reached waypoint, continuing to ${d.targetLabel}`, {
          droneId: d.spec.id,
        });
      } else if (mission && mission.waypointIndex === mission.waypoints.length - 1) {
        d.state = "landing";
        this.gateway.push("landing", `${d.spec.callsign} arriving at ${d.targetLabel}`, { droneId: d.spec.id });
        this.releaseContract(d);
      }
    }
  }

  private stepLanding(d: InternalDrone, dt: number): void {
    d.pos.z = Math.max(0, d.pos.z - 4 * dt);
    d.vel = { x: 0, y: 0, z: 0 };
    if (d.pos.z <= 0.2) {
      d.state = "landed";
      if (d.reservedSiteId) {
        const site = this.scenario.landingSites.find((s) => s.id === d.reservedSiteId);
        if (site) site.used = Math.max(0, site.used - 1);
        d.reservedSiteId = null;
      }
      this.gateway.push("drone-landed", `${d.spec.callsign} landed`, { droneId: d.spec.id });
      this.auditAppend("landing", d.spec.id, {});
      d.removeAtS = this.simTimeS + 20; // linger briefly, then leave the sector
      return;
    }
  }

  private startReroute(d: InternalDrone): void {
    const goal = d.mission?.waypoints[d.mission.waypointIndex];
    if (!goal) return;
    d.state = "rerouting";
    const obstacles = this.currentObstacles();
    // Replan at the mission lane altitude so reroutes keep the vertical
    // deconfliction that lane separation provides.
    const laneZ = goal.z;
    const start = { ...d.pos, z: laneZ };
    let path = planAStar(start, goal, obstacles);
    if (!path) path = planRrt(start, goal, obstacles, d.rng.branch(this.tickCounter % 101));
    if (!path || path.length < 2) {
      // No alternate route: hold position, try again shortly.
      d.state = "en-route";
      d.conformanceSinceS = this.simTimeS + CONFIG.conformance.rerouteAfterS + 2;
      return;
    }
    // Atomic replacement: the candidate must clear the 4D index before the
    // current reservation is released; on conflict we keep flying the
    // existing contract and retry later.
    const replaced = this.requestReplacement(d.spec.id, path, d.mission?.cruiseSpeed ?? d.spec.cruiseSpeed);
    if (!replaced) {
      d.state = "en-route";
      d.rerouteRetryAtS = this.simTimeS + 5;
      d.conformanceSinceS = this.simTimeS + 5;
      return;
    }
    this.counters.reroutes++;
    d.conformanceState = "conforming";
    d.conformanceSinceS = null;
    this.gateway.push("reroute", `${d.spec.callsign} rerouted around obstacle/weather`, {
      droneId: d.spec.id,
      data: { pathPoints: path.length },
    });
    this.auditAppend("reroute", d.spec.id, {});
    d.state = "en-route";
  }

  private retargetToLanding(d: InternalDrone): void {
    if (this.simTimeS < d.retargetRetryAtS) return;
    const site = this.nearestLandingSite(d.pos);
    if (!site) return;
    const obstacles = this.currentObstacles();
    const start = { ...d.pos, z: d.pos.z };
    const raw = planAStar(start, site.pos, obstacles) ?? planRrt(start, site.pos, obstacles, d.rng.branch(555));
    if (!raw || raw.length < 2) {
      d.retargetRetryAtS = this.simTimeS + 5;
      return;
    }
    // Add a descent profile down to the pad.
    const path = withVerticalProfile(raw, d.pos.z, 0);
    // Reserve before mutating mission state; on conflict keep the current
    // contract and retry shortly (the emergency still holds a reservation).
    const replaced = this.requestReplacement(d.spec.id, path, d.spec.cruiseSpeed * 0.8);
    if (!replaced) {
      d.retargetRetryAtS = this.simTimeS + 5;
      return;
    }
    if (d.reservedSiteId && d.reservedSiteId !== site.id) {
      const old = this.scenario.landingSites.find((s) => s.id === d.reservedSiteId);
      if (old) old.used = Math.max(0, old.used - 1);
      d.reservedSiteId = site.id;
      site.used++;
    } else if (!d.reservedSiteId) {
      d.reservedSiteId = site.id;
      site.used++;
    }
    if (d.spawnSiteId) this.releaseSpawnSlot(d);
    d.state = "returning";
    if (!d.mission) return;
    d.mission.waypoints = [site.pos];
    d.mission.waypointIndex = 0;
    d.targetLabel = `emergency: ${site.name}`;
  }

  /** Free the pad the drone spawned from (at departure or on emergency). */
  private releaseSpawnSlot(d: InternalDrone): void {
    if (!d.spawnSiteId) return;
    const site = this.scenario.landingSites.find((s) => s.id === d.spawnSiteId);
    if (site) site.used = Math.max(0, site.used - 1);
    d.spawnSiteId = null;
  }

  private releaseContract(d: InternalDrone): void {
    if (d.contractId) {
      this.index.releaseContract(d.contractId);
      this.contracts.delete(d.contractId);
      d.contractId = null;
    }
  }

  /** The drone's active contract id (null when none). Public for observability. */
  droneContractId(droneId: string): string | null {
    return this.drones.get(droneId)?.contractId ?? null;
  }

  /**
   * Atomically replace a drone's trajectory contract with a new path:
   * the candidate is validated against the 4D index BEFORE the current
   * reservation is released. On conflict the current reservation is kept
   * intact, contractsRejected is incremented and a contract-rejected event
   * is emitted; the drone never flies without a reservation it holds.
   */
  requestReplacement(droneId: string, path: Point3[], speedMps: number): boolean {
    const d = this.drones.get(droneId);
    if (!d) return false;
    const contract = buildContract(droneId, path, { speedMps, t0: this.simTimeS });
    const conflicting = this.index.conflicts(contract, droneId);
    if (conflicting.length > 0) {
      this.counters.contractsRejected++;
      this.gateway.push(
        "contract-rejected",
        `replacement contract conflicts with ${conflicting[0]?.droneId} - keeping current reservation`, {
          droneId,
          data: { with: conflicting[0]?.droneId },
        }
      );
      return false;
    }
    if (d.contractId) {
      this.index.releaseContract(d.contractId);
      this.contracts.delete(d.contractId);
    }
    this.index.addContract(contract);
    this.contracts.set(contract.id, contract);
    d.contractId = contract.id;
    d.route = path;
    return true;
  }

  private assignMission(d: InternalDrone): void {
    const rng = d.rng;
    if (d.spec.role === "delivery") {
      // Reserve a destination pad with spare capacity (exclude the spawn pad).
      const candidates = this.scenario.landingSites.filter((s) => s.id !== d.spawnSiteId && s.used < s.capacity);
      const pool = candidates.length > 0 ? candidates : this.scenario.landingSites.filter((s) => s.id !== d.spawnSiteId);
      const target = rng.pick(pool.length > 0 ? pool : this.scenario.landingSites);
      target.used++;
      d.reservedSiteId = target.id;
      d.mission = {
        waypoints: [{ ...target.pos, z: d.spec.zLanes[0] as number }],
        waypointIndex: 0,
        cruiseSpeed: d.spec.cruiseSpeed,
        maxSpeed: d.spec.maxSpeed,
        home: { ...d.pos },
      };
    } else {
      // Surveillance circuit: two survey points then return home.
      const pts: Point3[] = [];
      for (let i = 0; i < 2; i++) {
        for (let tries = 0; tries < 20; tries++) {
          const p: Point3 = {
            x: rng.range(200, CONFIG.sector.widthM - 200),
            y: rng.range(200, CONFIG.sector.heightM - 200),
            z: d.spec.zLanes[0] as number,
          };
          if (!pointBlocked(p, this.currentObstacles(), 25)) {
            pts.push(p);
            break;
          }
        }
      }
      const home = { ...d.pos, z: d.spec.zLanes[0] as number };
      d.mission = {
        waypoints: [...pts, home],
        waypointIndex: 0,
        cruiseSpeed: d.spec.cruiseSpeed,
        maxSpeed: d.spec.maxSpeed,
        home,
      };
    }
  }

  private targetName(d: InternalDrone): string {
    const goal = d.mission?.waypoints[d.mission.waypointIndex];
    if (!goal) return "n/a";
    const site = this.scenario.landingSites.find(
      (s) => Math.abs(s.pos.x - goal.x) < 1 && Math.abs(s.pos.y - goal.y) < 1
    );
    if (site) return site.name;
    if (d.mission && d.mission.waypointIndex === d.mission.waypoints.length - 1) return "home";
    return `survey point ${d.mission?.waypointIndex ?? 0 + 1}`;
  }

  private currentObstacles(): Obstacle[] {
    const obstacles: Obstacle[] = this.scenario.geofences.map((g) => ({
      rect: g.rect,
      zMin: g.zMin,
      zMax: g.zMax,
    }));
    for (const wz of this.weather) {
      obstacles.push({ circle: { x: wz.center.x, y: wz.center.y, r: wz.radius }, zMin: 25, zMax: 125 });
    }
    return obstacles;
  }

  private weatherBlockingAhead(d: InternalDrone): boolean {
    if (this.weather.length === 0) return false;
    const route = d.route;
    if (route.length < 2) return false;
    const ahead = CONFIG.weather.rerouteLookaheadM;
    let traveled = 0;
    const ax = d.pos.x;
    const ay = d.pos.y;
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1] as Point3;
      const b = route[i] as Point3;
      const segLen = dist2(a.x, a.y, b.x, b.y);
      for (const wz of this.weather) {
        if (wz.intensity > 0.35 && segmentCircleIntersect(ax, ay, b.x, b.y, { x: wz.center.x, y: wz.center.y, r: wz.radius }, 0)) {
          return true;
        }
      }
      traveled += segLen;
      if (traveled > ahead) break;
    }
    return false;
  }

  private routeForControl(d: InternalDrone): Point3[] {
    const contract = d.contractId ? this.contracts.get(d.contractId) : undefined;
    if (contract) {
      // Remaining contract points from now on (downsampled).
      const out: Point3[] = [{ ...d.pos }];
      for (const pt of contract.points) {
        if (pt.t >= this.simTimeS && out.length < 80) out.push({ x: pt.x, y: pt.y, z: pt.z });
      }
      return out;
    }
    return d.route.length > 0 ? [d.pos, ...d.route.slice(1, 60)] : [d.pos];
  }

  private meshNeighborsFor(d: InternalDrone): NeighborPrediction[] {
    const out: NeighborPrediction[] = [];
    for (const other of this.drones.values()) {
      if (other.spec.id === d.spec.id) continue;
      // Ground states are not airborne traffic: the orchestrator's departure
      // sequencing (45 m pad clearance) handles pad safety instead.
      if (other.state === "landed" || other.state === "removed" || other.state === "waiting" || other.state === "launching" || other.state === "requesting") continue;
      const hd = dist2(d.pos.x, d.pos.y, other.pos.x, other.pos.y);
      if (hd > CONFIG.mesh.linkRadiusM && !other.flags.lostLink) continue;
      let radiusM = CONFIG.vo.marginM + (other.flags.untrusted ? CONFIG.vo.untrustedExtraMarginM : 0);
      if (other.flags.lostLink) radiusM = CONFIG.lostLink.exclusionRadiusM; // clear 100 m around last known position
      out.push({ pos: other.pos, vel: other.vel, radiusM });
    }
    return out;
  }

  private computeMeshLinks(): void {
    this.meshLinks = [];
    const ids = [...this.drones.keys()];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = this.drones.get(ids[i] as string);
        const b = this.drones.get(ids[j] as string);
        if (!a || !b) continue;
        if (a.state === "landed" || a.state === "removed" || b.state === "landed" || b.state === "removed") continue;
        const hd = dist2(a.pos.x, a.pos.y, b.pos.x, b.pos.y);
        const vd = Math.abs(a.pos.z - b.pos.z);
        if (hd < CONFIG.mesh.linkRadiusM && vd < 30) {
          this.meshLinks.push({ a: a.spec.id, b: b.spec.id, dist: Math.round(hd) });
        }
      }
    }
  }

  private checkSeparation(): void {
    let nearPairs = 0;
    const ids = [...this.drones.keys()];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = this.drones.get(ids[i] as string);
        const b = this.drones.get(ids[j] as string);
        if (!a || !b) continue;
        if (a.state === "landed" || a.state === "removed" || b.state === "landed" || b.state === "removed") continue;
        if (a.state === "waiting" || a.state === "launching" || b.state === "waiting" || b.state === "launching") continue;
        const d3 = dist3(a.pos, b.pos);
        const hd = dist2(a.pos.x, a.pos.y, b.pos.x, b.pos.y);
        const vd = Math.abs(a.pos.z - b.pos.z);
        if (hd < CONFIG.separation.safetyMarginM && vd < CONFIG.separation.minVertSepM) {
          nearPairs++;
          const pairKey = [a.spec.id, b.spec.id].sort().join("|");
          const last = this.breachCooldown.get(pairKey) ?? -Infinity;
          if (this.simTimeS - last > CONFIG.separation.breachCooldownS) {
            this.breachCooldown.set(pairKey, this.simTimeS);
            this.counters.safetyBreaches++;
            this.gateway.push("safety-breach", `${a.spec.callsign} / ${b.spec.callsign} proximity ${d3.toFixed(0)}m (<18m)`, {
              data: { distM: Math.round(d3 * 10) / 10, a: a.spec.id, b: b.spec.id },
            });
            this.auditAppend("safety-breach", a.spec.id, { distM: Math.round(d3 * 10) / 10, with: b.spec.id });
          }
        }
      }
    }
    this.counters.nearMissPairs = nearPairs;
  }

  private checkGeofences(d: InternalDrone): void {
    let inside: string | null = null;
    for (const gf of this.scenario.geofences) {
      if (d.pos.z < gf.zMin || d.pos.z > gf.zMax) continue;
      if (pointInRect(d.pos, gf.rect, -3)) {
        inside = gf.id;
        break;
      }
    }
    if (inside && d.insideGeofence !== inside) {
      // Entry: one distinct, audited geofence-violation event.
      d.insideGeofence = inside;
      const gf = this.scenario.geofences.find((g) => g.id === inside);
      this.gateway.push("geofence-violation", `${d.spec.callsign} entered geofence ${gf?.name ?? inside}`, {
        droneId: d.spec.id,
        data: { geofence: inside },
      });
      this.auditAppend("geofence-violation", d.spec.id, { geofence: inside });
    } else if (!inside) {
      d.insideGeofence = null;
    }
  }

  private nearestLandingSite(pos: Point3): LandingSite | null {
    let best: LandingSite | null = null;
    let bestD = Infinity;
    for (const s of this.scenario.landingSites) {
      const d = dist2(pos.x, pos.y, s.pos.x, s.pos.y);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  private recordTelemetry(): void {
    if (this.tickCounter % 5 !== 0) return; // 2 Hz
    for (const d of this.drones.values()) {
      this.index.recordTelemetry(d.spec.id, this.simTimeS, d.pos);
    }
  }

  private auditAppend(type: string, droneId?: string, data?: Record<string, unknown>): void {
    this.audit.append(this.simTimeS, this.tickCounter, type, { droneId, data });
    this.counters.auditEntries = this.audit.entries.length;
  }

  // --------------------------------------------------------------- commands

  addDrone(role: DroneRole): { ok: boolean; droneId?: string; message: string } {
    if (this.drones.size >= CONFIG.engine.maxDrones) {
      return { ok: false, message: "Sector at capacity" };
    }
    const cfg = CONFIG.drones[role];
    const name = `ADD${String(this.droneSerial).padStart(3, "0")}`;
    const spec: DroneSpec = {
      id: role === "delivery" ? `DEL-${String(this.droneSerial).padStart(3, "0")}` : `SUR-${String(this.droneSerial).padStart(3, "0")}`,
      callsign: name,
      role,
      cruiseSpeed: cfg.cruiseMps,
      maxSpeed: cfg.maxMps,
      batteryCapacityWh: cfg.batteryWh,
      batteryDrawW: cfg.drawW,
      zLanes: [...cfg.zLanes],
      payloadKg: role === "delivery" ? 2.5 : 0.8,
    };
    this.spawnDrone(spec, false);
    return { ok: true, droneId: spec.id, message: `${spec.callsign} (${role}) spawned` };
  }

  setWeather(active: boolean, intensity = 0.8): void {
    this.weatherActive = active;
    this.weatherIntensity = intensity;
    if (active && this.weather.length === 0) {
      this.spawnWeatherZone();
      this.spawnWeatherZone();
      this.weatherNextSpawnS = this.simTimeS + CONFIG.weather.spawnEveryS;
    }
    this.gateway.push("weather-event", active ? "Weather event: turbulence advisory active" : "Weather event cleared", {});
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.gateway.push("system", paused ? "Simulation paused" : "Simulation resumed", {});
  }

  reset(): void {
    this.init();
    this.gateway.push("system", "Simulation reset", {});
  }

  setSpoof(droneId: string, on: boolean): { ok: boolean; message: string } {
    const d = this.drones.get(droneId);
    if (!d) return { ok: false, message: `Unknown drone ${droneId}` };
    d.spoofOn = on;
    d.fusion.setSpoof(on, 30);
    if (on) {
      this.gateway.push("spoof-enabled", `${d.spec.callsign}: ADS-B spoofing injected (test scenario)`, { droneId });
    }
    return { ok: true, message: on ? "Spoofing injected" : "Spoofing cleared" };
  }

  setLostLink(droneId: string, on: boolean): { ok: boolean; message: string } {
    const d = this.drones.get(droneId);
    if (!d) return { ok: false, message: `Unknown drone ${droneId}` };
    if (on && !d.flags.lostLink) {
      d.flags.lostLink = true;
      d.lostLinkSinceS = this.simTimeS;
      this.counters.lostLinkEvents++;
      this.gateway.push("lost-link", `${d.spec.callsign}: link lost - emergency landing, clearing 100m exclusion zone`, {
        droneId,
      });
      this.auditAppend("lost-link", d.spec.id, {});
      // Pre-programmed emergency landing: install a deconflicted contract to
      // the nearest pad. On conflict the current reservation is kept and the
      // retarget is retried on cooldown (stepDrone drives the retry).
      this.attemptLostLinkRetarget(d);
    } else if (!on) {
      d.flags.lostLink = false;
      d.lostLinkSinceS = null;
      d.lostLinkTargeted = false;
    }
    return { ok: true, message: on ? "Link lost (emergency landing)" : "Link restored" };
  }

  /** Plan + atomically reserve the lost-link emergency landing contract. */
  private attemptLostLinkRetarget(d: InternalDrone): void {
    if (d.lostLinkTargeted || !d.mission) return;
    if (this.simTimeS < d.retargetRetryAtS) return;
    const site = this.nearestLandingSite(d.pos);
    if (!site) return;
    const obstacles = this.currentObstacles();
    const start = { ...d.pos, z: d.pos.z };
    const raw = planAStar(start, site.pos, obstacles) ?? planRrt(start, site.pos, obstacles, d.rng.branch(777));
    if (!raw || raw.length < 2) {
      d.retargetRetryAtS = this.simTimeS + 5;
      return;
    }
    const path = withVerticalProfile(raw, d.pos.z, 0);
    if (!this.requestReplacement(d.spec.id, path, d.spec.cruiseSpeed * 0.8)) {
      d.retargetRetryAtS = this.simTimeS + 5;
      return;
    }
    // Reservation secured: now commit the mission change and slot transfer.
    if (d.reservedSiteId && d.reservedSiteId !== site.id) {
      const old = this.scenario.landingSites.find((s) => s.id === d.reservedSiteId);
      if (old) old.used = Math.max(0, old.used - 1);
      d.reservedSiteId = site.id;
      site.used++;
    } else if (!d.reservedSiteId) {
      d.reservedSiteId = site.id;
      site.used++;
    }
    if (d.spawnSiteId) this.releaseSpawnSlot(d);
    d.mission.waypoints = [{ ...site.pos }];
    d.mission.waypointIndex = 0;
    d.targetLabel = `lost-link landing: ${site.name}`;
    d.lostLinkTargeted = true;
    this.gateway.push("landing", `${d.spec.callsign} emergency approach to ${site.name}`, { droneId: d.spec.id });
  }

  queryAirspace(q: AirspaceQuery): AirspaceQueryResult {
    return this.index.queryCube(q);
  }

  // -------------------------------------------------------------- snapshot

  snapshot(): Snapshot {
    const drones: DroneView[] = [];
    for (const d of this.drones.values()) {
      const fused = d.fusion.fused();
      const contract = d.contractId ? this.contracts.get(d.contractId) : undefined;
      const dev = contract ? deviationFromContract(d.pos, contract, this.simTimeS) : { hM: 0, vM: 0 };
      const speed = Math.hypot(d.vel.x, d.vel.y);
      const route = d.route
        .filter((_, i) => i % 3 === 0)
        .slice(0, 120)
        .map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }));
      const trail = d.trail.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 }));
      drones.push({
        id: d.spec.id,
        callsign: d.spec.callsign,
        role: d.spec.role,
        state: d.state,
        flags: { ...d.flags },
        conformance: d.conformanceState,
        x: Math.round(fused.pos.x * 10) / 10,
        y: Math.round(fused.pos.y * 10) / 10,
        z: Math.round(fused.pos.z * 10) / 10,
        vx: Math.round(fused.velocity.x * 10) / 10,
        vy: Math.round(fused.velocity.y * 10) / 10,
        vz: Math.round(fused.velocity.z * 10) / 10,
        headingDeg: Math.round((Math.atan2(d.vel.y, d.vel.x) * 180) / Math.PI),
        speedMps: Math.round(speed * 10) / 10,
        batteryPct: Math.round(((d.batteryWh / d.spec.batteryCapacityWh) * 1000)) / 10,
        trust: fused.trust,
        primarySource: fused.primarySource,
        sources: fused.sources,
        route,
        trail,
        contractId: d.contractId,
        contractStatus: contract?.status ?? null,
        deviationM: Math.round(dev.hM),
        targetLabel: d.targetLabel,
      });
    }
    drones.sort((a, b) => a.id.localeCompare(b.id));

    return {
      tick: this.tickCounter,
      simTimeS: Math.round(this.simTimeS * 10) / 10,
      paused: this.paused,
      sector: { widthM: CONFIG.sector.widthM, heightM: CONFIG.sector.heightM, zMax: CONFIG.sector.zMax },
      geofences: this.scenario.geofences,
      landingSites: this.scenario.landingSites,
      weather: this.weather.map((w) => ({ ...w, radius: Math.round(w.radius) })),
      drones,
      meshLinks: this.meshLinks,
      counters: { ...this.counters },
      recentEvents: [...this.recentEvents].slice(-25),
    };
  }
}

function makeScenarioCopy(s: Scenario): Scenario {
  return {
    seed: s.seed,
    geofences: s.geofences.map((g) => ({ ...g, rect: { ...g.rect } })),
    landingSites: s.landingSites.map((l) => ({ ...l, pos: { ...l.pos } })),
    droneSpecs: s.droneSpecs.map((d) => ({ ...d, zLanes: [...d.zLanes] })),
  };
}

/** Deterministic per-drone avoidance bias in degrees (-25..25), hashed from
 * the full drone id so standard ids (DEL-001, SUR-001, ...) diverge. */
export function biasForDrone(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h * 33) ^ id.charCodeAt(i)) >>> 0;
  return (h % 51) - 25;
}
