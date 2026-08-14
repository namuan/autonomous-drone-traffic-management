/**
 * Central configuration: every tunable threshold in the system lives here
 * so behavior stays consistent (spoofing, conformance, proximity values are
 * referenced from PLAN.md and are simulation parameters, not certified limits).
 */
export const CONFIG = {
  sector: { widthM: 2000, heightM: 1000, zMax: 150 },

  engine: {
    tickMs: 100, // 10 Hz fixed step
    trailSampleEveryTicks: 2, // trail point every 200 ms
    maxTrailPoints: 60, // ~12 s of history
    maxDrones: 40,
  },

  mesh: {
    linkRadiusM: 80, // mesh neighbors share predicted trajectories within 80 m
    maxNeighbors: 10,
  },

  separation: {
    safetyMarginM: 18, // proximity events below 18 m (PLAN.md section 3)
    minVertSepM: 15, // 15 m vertical separation counts as deconflicted
    breachCooldownS: 5, // re-alert the same pair at most every 5 s
  },

  trust: {
    spoofWarnM: 15, // PLAN.md: flag potential spoofing beyond 15 m divergence
    spoofUntrustedM: 20, // PLAN.md: untrusted beyond 20 m sustained divergence
    untrustedPersistS: 4, // sustained divergence time before untrusted flag
    recoveryPerSec: 0.03,
    opticalPrimaryBelow: 0.45, // ADS-B trust below this -> optical-primary mode
  },

  conformance: {
    horizontalM: 30, // PLAN.md section 6
    verticalM: 15,
    rerouteAfterS: 3, // persistent non-conformance triggers a reroute
  },

  battery: {
    criticalPct: 10, // below 10% -> critical status (PLAN.md section 3)
    emergencyReservePct: 5,
  },

  lostLink: {
    exclusionRadiusM: 100, // other drones clear 100 m around last known position
  },

  planning: {
    rrt: {
      maxIterations: 1500,
      goalBias: 0.08,
      stepM: 45,
      rewireRadiusM: 90,
      obstacleMarginM: 12,
      minPathPoints: 2,
    },
    astar: {
      resolutionM: 10, // 10 m voxel grid (PLAN.md section 2.1)
      obstacleMarginM: 8,
    },
    contractSampleS: 1, // 4D contract sampled every second
    minStartClearanceM: 25,
  },

  mpc: {
    horizonS: 3, // predict 3 s forward (PLAN.md section 2.3)
    sampleStepS: 0.5,
    headingOffsetsDeg: [-160, -120, -80, -40, -20, 0, 20, 40, 80, 120, 160],
    speedFactors: [0.55, 0.8, 1.0],
    zRates: [-3, 0, 3],
    weights: { path: 0.5, target: 1.0, energy: 0.35, weather: 2.2, separation: 3.5, turn: 0.2, altitude: 0.5 },
    voFallbackMarginM: 24, // trigger VO when predicted clearance falls below this
  },

  vo: {
    horizonS: 3,
    marginM: 18,
    untrustedExtraMarginM: 12,
  },

  weather: {
    maxZones: 4,
    minRadiusM: 90,
    maxRadiusM: 200,
    expansionPeriodS: 45,
    lifetimeS: 240,
    spawnEveryS: 18,
    disturbanceMps: 2.2,
    rerouteLookaheadM: 60,
  },

  drones: {
    delivery: {
      cruiseMps: 12,
      maxMps: 16,
      batteryWh: 90,
      drawW: 170, // ~31 min endurance
      zLanes: [40, 55, 70],
      count: 5,
    },
    surveillance: {
      cruiseMps: 8,
      maxMps: 12,
      batteryWh: 120,
      drawW: 150, // ~48 min endurance
      zLanes: [85, 100, 115],
      count: 2,
    },
  },

  launch: {
    durationS: 3,
  },
} as const;

export type SimulationConfig = typeof CONFIG;
