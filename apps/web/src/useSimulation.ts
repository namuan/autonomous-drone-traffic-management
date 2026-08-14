import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientCommand, Snapshot, SystemEvent } from "@utm/core";
import type { SimFrame } from "./world3d/math.js";

export interface SimulationState {
  snapshot: Snapshot | null;
  prevSnapshot: Snapshot | null;
  lastSnapTime: number;
  /** Atomic snapshot pairing for interpolation (previous + current + receipt time). */
  frame: SimFrame | null;
  connected: boolean;
  events: SystemEvent[];
  selectedId: string | null;
  select: (id: string | null) => void;
  error: string | null;
}

const wsUrl = () => `${location.protocol === "https:" ? "wss://" : "ws://"}${location.host}/ws`;

export function useSimulation(): SimulationState {
  const [frame, setFrame] = useState<SimFrame | null>(null);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const select = useCallback((id: string | null) => setSelectedId(id), []);
  // WebSocket stream with reconnect.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry = 0;
    let closed = false;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(wsUrl());
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setConnected(true);
        setError(null);
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as { kind: string; snapshot?: Snapshot; event?: SystemEvent };
          if (msg.kind === "snapshot" && msg.snapshot) {
            setFrame((prev) => ({
              current: msg.snapshot as Snapshot,
              previous: prev?.current ?? null,
              receivedAtMs: performance.now(),
            }));
          } else if (msg.kind === "event" && msg.event) {
            setEvents((prev) => [...prev.slice(-80), msg.event as SystemEvent]);
          }
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) {
          retry++;
          setTimeout(connect, Math.min(2000, 300 * retry));
        }
      };
      ws.onerror = () => {
        setError("WebSocket error - reconnecting");
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, []);

  return {
    snapshot: frame?.current ?? null,
    prevSnapshot: frame?.previous ?? null,
    lastSnapTime: frame?.receivedAtMs ?? 0,
    frame,
    connected,
    events,
    selectedId,
    select,
    error,
  };
}

/** POST a command to the REST API. */
export async function postCommand(cmd: ClientCommand): Promise<{ ok: boolean; message?: string }> {
  const { type, ...rest } = cmd as { type: string; [k: string]: unknown };
  let url = "";
  let body: unknown = rest;
  switch (type) {
    case "add-drone":
      url = "/api/drones";
      body = rest;
      break;
    case "weather":
      url = "/api/commands/weather";
      break;
    case "pause":
      url = "/api/commands/pause";
      break;
    case "reset":
      url = "/api/commands/reset";
      break;
    case "spoof":
      url = `/api/drones/${rest.droneId}/spoof`;
      body = { on: rest.on };
      break;
    case "lost-link":
      url = `/api/drones/${rest.droneId}/lost-link`;
      body = { on: rest.on };
      break;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { message?: string };
      return { ok: false, message: errBody.message ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: "Network error" };
  }
}

export function fmtSimTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const tenth = Math.floor((sec % 1) * 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${tenth}`;
}
