/**
 * Identity & trust: demo Remote-ID-like registry with real Ed25519
 * signatures (node:crypto). Every drone is registered to an operator and
 * signs heartbeat telemetry; the gateway verifies signatures on receipt.
 * This is demo data - not ASTM F3411 conformance and not blockchain.
 */

import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

interface DroneIdentity {
  droneId: string;
  operatorId: string;
  publicKey: KeyObject;
  privateKey: KeyObject;
}

export class IdentityRegistry {
  private identities = new Map<string, DroneIdentity>();
  private operators = new Map<string, string>(); // operatorId -> display name

  constructor() {
    this.operators.set("OP-AERODEPOT", "AeroDepot East");
    this.operators.set("OP-NORTHLIFT", "NorthLift Logistics");
    this.operators.set("OP-RIVERCITY", "RiverCity Surveillance Co.");
  }

  registerDrone(droneId: string, operatorId: string): void {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    this.identities.set(droneId, { droneId, operatorId, publicKey, privateKey });
  }

  isRegistered(droneId: string): boolean {
    return this.identities.has(droneId);
  }

  signHeartbeat(droneId: string, payload: string): { payload: string; signature: string } {
    const id = this.identities.get(droneId);
    if (!id) throw new Error(`Unknown drone identity: ${droneId}`);
    const signature = cryptoSign(null, Buffer.from(payload, "utf8"), id.privateKey);
    return { payload, signature: signature.toString("base64") };
  }

  verifyHeartbeat(droneId: string, payload: string, signatureB64: string): boolean {
    const id = this.identities.get(droneId);
    if (!id) return false;
    try {
      return cryptoVerify(null, Buffer.from(payload, "utf8"), id.publicKey, Buffer.from(signatureB64, "base64"));
    } catch {
      return false;
    }
  }

  heartbeatPayload(droneId: string, t: number, x: number, y: number, z: number): string {
    return JSON.stringify({ droneId, t, x, y, z });
  }

  operatorName(operatorId: string): string {
    return this.operators.get(operatorId) ?? operatorId;
  }

  /** Drop all registered identities (used on engine reset). */
  clear(): void {
    this.identities.clear();
  }
}

/**
 * Tamper-evident audit chain: each critical event is hashed together with the
 * previous hash (SHA-256), forming a chain. verify() recomputes the chain and
 * reports the first broken link. Simulation of a permissioned blockchain
 * anchor, not a distributed ledger.
 */
export interface AuditEntry {
  seq: number;
  ts: number;
  tick: number;
  type: string;
  droneId?: string;
  data?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

const GENESIS = "genesis";

export class AuditChain {
  entries: AuditEntry[] = [];
  head = GENESIS;

  append(ts: number, tick: number, type: string, opts?: { droneId?: string; data?: Record<string, unknown> }): AuditEntry {
    const payload = JSON.stringify({ ts, tick, type, droneId: opts?.droneId ?? null, data: opts?.data ?? null });
    const hash = createHash("sha256").update(`${this.head}|${payload}`).digest("hex");
    const entry: AuditEntry = {
      seq: this.entries.length + 1,
      ts,
      tick,
      type,
      droneId: opts?.droneId,
      data: opts?.data,
      prevHash: this.head,
      hash,
    };
    this.entries.push(entry);
    this.head = hash;
    return entry;
  }

  /** Recompute the chain; return the first entry where the link is broken. */
  verify(): { ok: boolean; brokenAt?: number } {
    let prev = GENESIS;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i] as AuditEntry;
      const payload = JSON.stringify({ ts: e.ts, tick: e.tick, type: e.type, droneId: e.droneId ?? null, data: e.data ?? null });
      const recomputed = createHash("sha256").update(`${e.prevHash}|${payload}`).digest("hex");
      if (e.prevHash !== prev || recomputed !== e.hash) {
        return { ok: false, brokenAt: e.seq };
      }
      prev = e.hash;
    }
    return { ok: true };
  }

  clear(): void {
    this.entries = [];
    this.head = GENESIS;
  }
}
