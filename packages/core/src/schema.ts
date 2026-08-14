/**
 * The wire schema shared between the API server and the web console.
 * The server owns the simulation; the browser only renders snapshots and
 * issues commands.
 */

import type {
  Counters,
  ConformanceState,
  DroneFlags,
  DroneRole,
  DroneState,
  Geofence,
  LandingSite,
  MeshLink,
  SensorName,
  SourceTrust,
  WeatherZone,
} from "./types.js";
import type { SystemEvent } from "./events.js";

export interface DroneView {
  id: string;
  callsign: string;
  role: DroneRole;
  state: DroneState;
  flags: DroneFlags;
  conformance: ConformanceState;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  headingDeg: number;
  speedMps: number;
  batteryPct: number;
  /** Overall fusion trust 0..1 */
  trust: number;
  primarySource: SensorName;
  sources: SourceTrust[];
  /** Planned route polyline (meters). */
  route: { x: number; y: number; z: number }[];
  /** Actual flight trail (meters, most recent last). */
  trail: { x: number; y: number; z: number }[];
  contractId: string | null;
  contractStatus: string | null;
  /** Distance from planned contract path, meters. */
  deviationM: number;
  targetLabel: string | null;
}

export interface Snapshot {
  tick: number;
  simTimeS: number;
  paused: boolean;
  sector: {
    widthM: number;
    heightM: number;
    zMax: number;
  };
  geofences: Geofence[];
  landingSites: LandingSite[];
  weather: WeatherZone[];
  drones: DroneView[];
  meshLinks: MeshLink[];
  counters: Counters;
  recentEvents: SystemEvent[];
}

export type ClientCommand =
  | { type: "add-drone"; role: DroneRole }
  | { type: "weather"; active: boolean; intensity?: number }
  | { type: "pause"; paused: boolean }
  | { type: "reset" }
  | { type: "spoof"; droneId: string; on: boolean }
  | { type: "lost-link"; droneId: string; on: boolean };

export interface CommandResult {
  ok: boolean;
  message: string;
  droneId?: string;
}

export interface AirspaceQuery {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  t0: number;
  t1: number;
}

export interface AirspaceQueryResult {
  cube: AirspaceQuery;
  matches: { droneId: string; from: "contract" | "telemetry"; t: number }[];
  contractCount: number;
  telemetryCount: number;
}

export interface AuditEntryView {
  seq: number;
  ts: number;
  type: string;
  droneId?: string;
  hash: string;
  prevHash: string;
}

export interface AuditStateView {
  verified: boolean;
  entries: AuditEntryView[];
  head: string;
}

export interface WsMessage {
  kind: "snapshot" | "event";
  snapshot?: Snapshot;
  event?: SystemEvent;
}
