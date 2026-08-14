/**
 * Sensor fusion: a bank of constant-velocity Kalman filters, one per source
 * (ADS-B, radar, optical, lidar, cellular), with per-source innovation-based
 * trust scores. The fused state is the trust-weighted blend of source
 * estimates. When ADS-B and radar diverge beyond PLAN.md's thresholds the
 * system switches to optical-primary mode and can flag the aircraft untrusted.
 *
 * Simulation, not certified avionics: observation noise/dropout are configured
 * models, and "sources" are synthetic observations of the true engine state.
 */

import { CONFIG } from "@utm/core";
import type { Point3, SensorName, SensorSource, SourceTrust } from "@utm/core";
import { SeededRandom } from "@utm/core";

export const SENSOR_SOURCES: SensorSource[] = [
  { name: "ads-b", hz: 1, noiseM: 8, dropout: 0.01 },
  { name: "radar", hz: 10, noiseM: 3, dropout: 0.02 },
  { name: "optical", hz: 5, noiseM: 5, dropout: 0.05 },
  { name: "lidar", hz: 10, noiseM: 2, dropout: 0.03 },
  { name: "cellular", hz: 0.5, noiseM: 25, dropout: 0.15 },
];

/** Per-axis constant-velocity Kalman filter (state [pos, vel]). */
class KalmanAxis {
  p = 0;
  v = 0;
  private p11 = 100;
  private p12 = 0;
  private p22 = 100;
  private q: number;

  constructor(q: number) {
    this.q = q;
  }

  predict(dt: number): void {
    // F = [[1, dt], [0, 1]], process noise on velocity = q*dt
    const p11 = this.p11 + 2 * dt * this.p12 + dt * dt * this.p22 + this.q * dt;
    const p12 = this.p12 + dt * this.p22;
    const p22 = this.p22 + this.q * dt;
    this.p11 = p11;
    this.p12 = p12;
    this.p22 = p22;
    this.p += this.v * dt;
  }

  update(obs: number, r: number): number {
    const s = this.p11 + r;
    const k1 = this.p11 / s;
    const k2 = this.p12 / s;
    const innovation = obs - this.p;
    this.p += k1 * innovation;
    this.v += k2 * innovation;
    this.p11 *= 1 - k1;
    this.p12 *= 1 - k1;
    this.p22 -= k2 * this.p12;
    return Math.abs(innovation);
  }

  get state(): { p: number; v: number } {
    return { p: this.p, v: this.v };
  }
}

class SourceFilter {
  trust = 1;
  lastInnovationM = 0;
  estimate: Point3 = { x: 0, y: 0, z: 0 };
  velocity: Point3 = { x: 0, y: 0, z: 0 };
  private axes = [new KalmanAxis(0.3), new KalmanAxis(0.3), new KalmanAxis(0.3)];
  private source: SensorSource;

  constructor(source: SensorSource) {
    this.source = source;
  }

  setInitial(pos: Point3): void {
    this.axes[0]!.p = pos.x;
    this.axes[1]!.p = pos.y;
    this.axes[2]!.p = pos.z;
    this.estimate = { ...pos };
  }

  predict(dt: number): void {
    for (const ax of this.axes) ax.predict(dt);
  }

  /** Apply an observation; returns innovation magnitude in meters. */
  observe(obs: Point3, rng: SeededRandom, force: boolean): number {
    const rx = this.source.noiseM * this.source.noiseM;
    const rz = Math.max(2, this.source.noiseM * 0.6);
    const innovations = [
      this.axes[0]!.update(obs.x, rx),
      this.axes[1]!.update(obs.y, rx),
      this.axes[2]!.update(obs.z, rz * rz),
    ];
    const combined = Math.hypot(innovations[0], innovations[1], innovations[2]);
    this.lastInnovationM = combined;
    this.estimate = {
      x: this.axes[0]!.state.p,
      y: this.axes[1]!.state.p,
      z: this.axes[2]!.state.p,
    };
    this.velocity = {
      x: this.axes[0]!.state.v,
      y: this.axes[1]!.state.v,
      z: this.axes[2]!.state.v,
    };
    // Trust dynamics: large innovations relative to expected noise drop trust.
    const expectedNoise = Math.hypot(this.source.noiseM, this.source.noiseM, this.source.noiseM * 0.6);
    if (combined > 3 * expectedNoise) {
      this.trust = Math.max(0, this.trust - 0.18 * (force ? 2 : 1));
    } else {
      this.trust = Math.min(1, this.trust + CONFIG.trust.recoveryPerSec / this.source.hz);
    }
    return combined;
  }
}

export interface FusionOptions {
  spoofAdsB?: boolean;
  spoofOffsetM?: number;
}

export interface FusedState {
  pos: Point3;
  velocity: Point3;
  primarySource: SensorName;
  trust: number; // overall 0..1
  sources: SourceTrust[];
  adsBvsRadarM: number;
}

export class DroneFusion {
  private filters = new Map<SensorName, SourceFilter>();
  private lastObserved = new Map<SensorName, number>();
  private spoofAdsB = false;
  private spoofOffsetM = 30;

  constructor(initial: Point3) {
    for (const s of SENSOR_SOURCES) {
      const f = new SourceFilter(s);
      f.setInitial(initial);
      this.filters.set(s.name, f);
      this.lastObserved.set(s.name, -Infinity);
    }
  }

  setSpoof(on: boolean, offsetM = 30): void {
    this.spoofAdsB = on;
    this.spoofOffsetM = offsetM;
  }

  /** Advance one engine tick: generate observations, update filters, fuse. */
  step(simTimeS: number, truth: Point3, rng: SeededRandom): FusedState {
    for (const s of SENSOR_SOURCES) {
      const f = this.filters.get(s.name) as SourceFilter;
      f.predict(0.1);
      const due = simTimeS - (this.lastObserved.get(s.name) ?? -Infinity);
      if (due < 1 / s.hz) continue;
      this.lastObserved.set(s.name, simTimeS);
      if (rng.next() < s.dropout) continue;

      let obs = truth;
      if (this.spoofAdsB && s.name === "ads-b") {
        // Spoofed ADS-B drifts away from the true position.
        const drift = Math.sin(simTimeS / 6) * 0.4 + 1;
        obs = {
          x: truth.x + this.spoofOffsetM * drift,
          y: truth.y + this.spoofOffsetM * drift * 0.7,
          z: truth.z,
        };
      }
      const noisy = {
        x: obs.x + rng.gaussian() * s.noiseM,
        y: obs.y + rng.gaussian() * s.noiseM,
        z: obs.z + rng.gaussian() * Math.max(2, s.noiseM * 0.6),
      };
      f.observe(noisy, rng, this.spoofAdsB && s.name === "ads-b");
    }

    // Cross-source trust: ADS-B vs radar divergence flags potential spoofing
    // (PLAN.md section 2.2: warn beyond 15 m).
    const adsBFilter = this.filters.get("ads-b") as SourceFilter;
    const radarFilter = this.filters.get("radar") as SourceFilter;
    const divergence = Math.hypot(
      adsBFilter.estimate.x - radarFilter.estimate.x,
      adsBFilter.estimate.y - radarFilter.estimate.y
    );
    if (divergence > CONFIG.trust.spoofWarnM) {
      adsBFilter.trust = Math.max(0, adsBFilter.trust - 0.15);
    } else {
      adsBFilter.trust = Math.min(1, adsBFilter.trust + 0.02);
    }
    return this.fused();
  }

  fused(): FusedState {
    let wx = 0;
    let wy = 0;
    let wz = 0;
    let wSum = 0;
    const sources: SourceTrust[] = [];
    for (const s of SENSOR_SOURCES) {
      const f = this.filters.get(s.name) as SourceFilter;
      // Accuracy-weighted: trust divided by measurement variance.
      const w = Math.max(0.02, f.trust) / (s.noiseM * s.noiseM);
      wx += f.estimate.x * w;
      wy += f.estimate.y * w;
      wz += f.estimate.z * w;
      wSum += w;
      sources.push({ source: s.name, trust: Math.round(f.trust * 100) / 100, lastInnovationM: Math.round(f.lastInnovationM * 10) / 10 });
    }
    const adsB = this.filters.get("ads-b") as SourceFilter;
    const radar = this.filters.get("radar") as SourceFilter;
    const adsBvsRadarM = Math.hypot(
      adsB.estimate.x - radar.estimate.x,
      adsB.estimate.y - radar.estimate.y
    );
    const primary: SensorName = adsB.trust >= CONFIG.trust.opticalPrimaryBelow ? "ads-b" : "optical";
    const trust = Math.round((wSum / SENSOR_SOURCES.length) * 100) / 100;

    return {
      pos: { x: wx / wSum, y: wy / wSum, z: wz / wSum },
      velocity: {
        x: (adsB.velocity.x * adsB.trust + radar.velocity.x * radar.trust) / (adsB.trust + radar.trust),
        y: (adsB.velocity.y * adsB.trust + radar.velocity.y * radar.trust) / (adsB.trust + radar.trust),
        z: 0,
      },
      primarySource: primary,
      trust,
      sources,
      adsBvsRadarM,
    };
  }
}
