/**
 * Telemetry gateway: priority-ordered delivery of system events.
 * Priorities follow PLAN.md section 2.4:
 *   P0 emergency commands (land, evade) - delivered first
 *   P1 trajectory updates / safety-critical
 *   P2 heartbeats and routine telemetry
 *   P3 logs and analytics
 * This is an in-memory simulation adapter; the interface boundary is where a
 * real MQTT/BEAM gateway (QoS 1, 50k connections) would plug in.
 */

import { EVENT_PRIORITY, type EventType, type SystemEvent } from "@utm/core";

export class PriorityGateway {
  private queues: SystemEvent[][] = [[], [], [], []];
  private nextId = 1;
  private subscribers = new Set<(e: SystemEvent) => void>();

  push(type: EventType, message: string, opts?: { droneId?: string; data?: Record<string, unknown> }): SystemEvent {
    const priority = EVENT_PRIORITY[type];
    const event: SystemEvent = {
      id: this.nextId++,
      ts: 0, // filled in by the engine
      tick: 0,
      priority,
      type,
      droneId: opts?.droneId,
      message,
      data: opts?.data,
    };
    this.queues[priority]!.push(event);
    return event;
  }

  /** Drain all queues, highest priority first; within a priority, FIFO. */
  flush(nowS: number, tick: number): SystemEvent[] {
    const out: SystemEvent[] = [];
    for (let p = 0; p <= 3; p++) {
      const q = this.queues[p]!;
      for (const e of q) {
        e.ts = nowS;
        e.tick = tick;
        out.push(e);
        for (const sub of this.subscribers) sub(e);
      }
      this.queues[p] = [];
    }
    return out;
  }

  subscribe(fn: (e: SystemEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  get pendingCount(): number {
    return this.queues.reduce((acc, q) => acc + q.length, 0);
  }

  /** Drop queued events and reset the sequence (used on engine reset). */
  clear(): void {
    this.queues = [[], [], [], []];
    this.nextId = 1;
  }
}
