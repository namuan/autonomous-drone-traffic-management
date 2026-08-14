/** Deterministic seeded RNG (mulberry32) so scenarios are reproducible. */

export class SeededRandom {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
    if (this.s === 0) this.s = 0x9e3779b9;
  }

  /** Uniform [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  int(lo: number, hi: number): number {
    return Math.floor(this.range(lo, hi + 1));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)] as T;
  }

  /** Approximate normal via central limit (mean 0, std 1). */
  gaussian(): number {
    let sum = 0;
    for (let i = 0; i < 6; i++) sum += this.next();
    return (sum - 3) * 0.8944;
  }

  /** A fresh independent stream derived from this one. */
  branch(label: number): SeededRandom {
    return new SeededRandom((this.s ^ Math.imul(label, 0x85ebca6b)) >>> 0);
  }
}
