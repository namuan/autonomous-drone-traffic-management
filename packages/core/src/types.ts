/**
 * Core domain types for the UTM simulation.
 * All spatial coordinates are meters in a local sector frame
 * (x: 0..SECTOR_WIDTH, y: 0..SECTOR_HEIGHT, z: altitude above ground).
 * Time is seconds since simulation start unless noted otherwise.
 */

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Circle {
  x: number;
  y: number;
  r: number;
}

export type DroneRole = "delivery" | "surveillance";

export type DroneState =
  | "requesting"
  | "waiting"
  | "launching"
  | "en-route"
  | "rerouting"
  | "returning"
  | "landing"
  | "landed"
  | "removed";

export interface DroneFlags {
  /** ADS-B / fusion trust collapsed below the untrusted threshold. */
  untrusted: boolean;
  /** Communications lost; drone performs a pre-programmed emergency landing. */
  lostLink: boolean;
  /** Battery at/below the critical threshold; landing is prioritized. */
  criticalBattery: boolean;
}

export type ConformanceState = "conforming" | "warning" | "deviating";

export interface Geofence {
  id: string;
  name: string;
  kind: "no-fly" | "restricted";
  rect: Rect;
  zMin: number;
  zMax: number;
}

export interface LandingSite {
  id: string;
  name: string;
  pos: Point3;
  capacity: number;
  used: number;
}

export interface WeatherZone {
  id: string;
  center: Point3;
  baseRadius: number;
  radius: number;
  intensity: number; // 0..1
  phase: number;
  ageSec: number;
}

export interface TrajectoryPoint extends Point3 {
  t: number; // seconds since simulation start
}

export type ContractStatus = "active" | "completed" | "revoked" | "rejected";

export interface TrajectoryContract {
  id: string;
  droneId: string;
  points: TrajectoryPoint[];
  hTolerance: number; // meters
  vTolerance: number; // meters
  status: ContractStatus;
}

export interface Waypoint {
  pos: Point3;
  kind: "pickup" | "drop" | "survey" | "landing";
}

export interface MissionPlan {
  waypoints: Waypoint[];
  cruiseSpeed: number;
  maxSpeed: number;
}

export interface SensorSource {
  name: SensorName;
  hz: number;
  noiseM: number;
  dropout: number; // probability an observation is missed
}

export type SensorName = "ads-b" | "radar" | "optical" | "lidar" | "cellular";

export interface SourceTrust {
  source: SensorName;
  trust: number; // 0..1
  lastInnovationM: number;
}

export interface DroneSpec {
  id: string;
  callsign: string;
  role: DroneRole;
  cruiseSpeed: number;
  maxSpeed: number;
  batteryCapacityWh: number;
  batteryDrawW: number;
  zLanes: number[]; // preferred cruise altitudes, low to high
  payloadKg: number;
}

export interface DroneStats {
  active: number;
  landed: number;
  waiting: number;
  untrusted: number;
  lostLink: number;
  criticalBattery: number;
}

export interface MeshLink {
  a: string;
  b: string;
  dist: number;
}

export interface Counters {
  contractsIssued: number;
  contractsRejected: number;
  reroutes: number;
  safetyBreaches: number;
  conformanceAlerts: number;
  untrustedFlags: number;
  lostLinkEvents: number;
  weatherEvents: number;
  auditEntries: number;
  gatewayEvents: number;
  nearMissPairs: number;
}
