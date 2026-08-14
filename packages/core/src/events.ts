/** System events: gateway priorities follow PLAN.md section 2.4. */

export type EventPriority = 0 | 1 | 2 | 3;

export type EventType =
  | "drone-requested"
  | "contract-issued"
  | "contract-rejected"
  | "launch"
  | "landing"
  | "drone-landed"
  | "reroute"
  | "conformance-alert"
  | "safety-breach"
  | "weather-event"
  | "untrusted-flagged"
  | "lost-link"
  | "emergency-landing"
  | "spoof-enabled"
  | "audit"
  | "system";

export interface SystemEvent {
  id: number;
  ts: number; // sim seconds
  tick: number;
  priority: EventPriority;
  type: EventType;
  droneId?: string;
  message: string;
  data?: Record<string, unknown>;
}

export const EVENT_PRIORITY: Record<EventType, EventPriority> = {
  "emergency-landing": 0,
  "lost-link": 0,
  "safety-breach": 1,
  "untrusted-flagged": 1,
  "contract-issued": 1,
  "launch": 1,
  "weather-event": 1,
  "conformance-alert": 2,
  "reroute": 2,
  "drone-requested": 2,
  "contract-rejected": 2,
  "spoof-enabled": 2,
  "landing": 2,
  "drone-landed": 3,
  "audit": 3,
  "system": 3,
};
