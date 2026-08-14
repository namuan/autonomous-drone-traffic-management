/** Seeded default scenario for Sector A1: geofences, landing sites, drone specs. */

import { CONFIG } from "./config.js";
import { SeededRandom } from "./rng.js";
import type { DroneSpec, Geofence, LandingSite } from "./types.js";

export interface Scenario {
  seed: number;
  geofences: Geofence[];
  landingSites: LandingSite[];
  droneSpecs: DroneSpec[];
}

const GEOFENCES: Geofence[] = [
  { id: "GF-HOSP-1", name: "St. Mary's Hospital", kind: "no-fly", rect: { x: 1620, y: 60, w: 180, h: 140 }, zMin: 0, zMax: 150 },
  { id: "GF-AIR-2", name: "Central Heliport", kind: "no-fly", rect: { x: 40, y: 760, w: 220, h: 160 }, zMin: 0, zMax: 150 },
  { id: "GF-GOV-3", name: "City Hall Complex", kind: "no-fly", rect: { x: 880, y: 760, w: 240, h: 170 }, zMin: 0, zMax: 150 },
  { id: "GF-POW-4", name: "Substation", kind: "restricted", rect: { x: 120, y: 120, w: 100, h: 90 }, zMin: 0, zMax: 60 },
];

const LANDING_SITES: LandingSite[] = [
  { id: "LS-NORTH", name: "North Rooftop", pos: { x: 300, y: 860, z: 0 }, capacity: 4, used: 0 },
  { id: "LS-DEPOT", name: "AeroDepot East", pos: { x: 1850, y: 860, z: 0 }, capacity: 8, used: 0 },
  { id: "LS-RIVER", name: "Riverside Pad", pos: { x: 980, y: 60, z: 0 }, capacity: 4, used: 0 },
  { id: "LS-SOUTH", name: "South Logistics", pos: { x: 300, y: 60, z: 0 }, capacity: 4, used: 0 },
];

const FIRST_NAMES = ["Meridian", "Kestrel", "Widgeon", "Albacore", "Firefly", "Nighthawk", "Cormorant", "Skylark", "Gannet", "Willow", "Badger", "Courier"];

export function makeScenario(seed = 20250101): Scenario {
  const rng = new SeededRandom(seed);
  const droneSpecs: DroneSpec[] = [];
  let seq = 1;

  const addBatch = (role: "delivery" | "surveillance", count: number) => {
    const cfg = CONFIG.drones[role];
    for (let i = 0; i < count; i++) {
      const prefix = role === "delivery" ? "DEL" : "SUR";
      const name = rng.pick(FIRST_NAMES);
      droneSpecs.push({
        id: `${prefix}-${String(seq).padStart(3, "0")}`,
        callsign: `${name}-${seq}`,
        role,
        cruiseSpeed: cfg.cruiseMps + rng.range(-1, 1),
        maxSpeed: cfg.maxMps,
        batteryCapacityWh: cfg.batteryWh,
        batteryDrawW: cfg.drawW,
        zLanes: [...cfg.zLanes],
        payloadKg: role === "delivery" ? 2.5 : 0.8,
      });
      seq++;
    }
  };

  addBatch("delivery", CONFIG.drones.delivery.count);
  addBatch("surveillance", CONFIG.drones.surveillance.count);

  return { seed, geofences: GEOFENCES, landingSites: LANDING_SITES, droneSpecs };
}

export const defaultScenario = makeScenario();
