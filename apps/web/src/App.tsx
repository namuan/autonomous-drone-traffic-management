import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import type { AirspaceQueryResult, DroneView } from "@utm/core";
import Ops2D from "./components/Ops2D.js";
import { fmtSimTime, postCommand, useSimulation } from "./useSimulation.js";
import "./styles.css";

// Three.js stays out of the initial bundle; the 3D world view loads on demand.
const World3DView = lazy(() => import("./world3d/World3DView.js"));

const PRIORITY_CLASS: Record<number, string> = { 0: "p0", 1: "p1", 2: "p2", 3: "p3" };

type ViewMode = "2d" | "3d";

export default function App() {
  const sim = useSimulation();
  const [view, setView] = useState<ViewMode>(() => (localStorage.getItem("utm.view") === "3d" ? "3d" : "2d"));
  const [fullscreen, setFullscreen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [queryResult, setQueryResult] = useState<AirspaceQueryResult | null>(null);
  const [queryBusy, setQueryBusy] = useState(false);

  // Persist the chosen view across reloads.
  useEffect(() => {
    localStorage.setItem("utm.view", view);
  }, [view]);

  // --------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (view === "3d" && e.key === "Escape") return; // the 3D view owns Escape
      switch (e.key) {
        case " ":
          e.preventDefault();
          void postCommand({ type: "pause", paused: !sim.snapshot?.paused });
          break;
        case "w":
        case "W":
          void postCommand({ type: "weather", active: !(sim.snapshot?.weather.length ?? 0 > 0) });
          break;
        case "d":
        case "D":
          void postCommand({ type: "add-drone", role: "delivery" });
          break;
        case "v":
        case "V":
          void postCommand({ type: "add-drone", role: "surveillance" });
          break;
        case "r":
        case "R":
          void postCommand({ type: "reset" });
          break;
        case "Escape":
          sim.select(null);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sim, view]);

  const snap = sim.snapshot;
  const selected: DroneView | undefined = snap?.drones.find((d) => d.id === sim.selectedId);

  const counters = useMemo(() => {
    const c = snap?.counters;
    return c
      ? [
          { label: "ACTIVE", value: snap.drones.filter((d) => d.state !== "landed" && d.state !== "removed").length, cls: "cyan" },
          { label: "CONTRACTS", value: c.contractsIssued, cls: "" },
          { label: "REROUTES", value: c.reroutes, cls: "" },
          { label: "BREACHES", value: c.safetyBreaches, cls: c.safetyBreaches > 0 ? "warn" : "" },
          { label: "UNTRUSTED", value: c.untrustedFlags, cls: c.untrustedFlags > 0 ? "warn" : "" },
          { label: "EVENTS", value: c.gatewayEvents, cls: "" },
        ]
      : [];
  }, [snap]);

  const act = async (cmd: Parameters<typeof postCommand>[0], msg: string) => {
    const res = await postCommand(cmd);
    setNotice(res.ok ? msg : `Command failed: ${res.message ?? "unknown error"}`);
    window.setTimeout(() => setNotice(null), 3000);
  };

  const runQuery = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setQueryBusy(true);
    const f = new FormData(e.currentTarget);
    const num = (k: string, d: number) => {
      const v = Number(f.get(k));
      return Number.isFinite(v) ? v : d;
    };
    const qs = new URLSearchParams({
      x0: String(num("x0", 0)),
      y0: String(num("y0", 0)),
      z0: String(num("z0", 0)),
      x1: String(num("x1", 2000)),
      y1: String(num("y1", 1000)),
      z1: String(num("z1", 150)),
      t0: String(num("t0", snap ? Math.round(snap.simTimeS - 60) : -60)),
      t1: String(num("t1", snap ? Math.round(snap.simTimeS + 300) : 300)),
    });
    const res = await fetch(`/api/queries/airspace?${qs}`);
    if (res.ok) setQueryResult((await res.json()) as AirspaceQueryResult);
    setQueryBusy(false);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">◉</span>
          <div>
            <h1>UTM · SECTOR A1</h1>
            <p>Autonomous drone traffic management — simulation console</p>
          </div>
        </div>
        <div className="clock" data-testid="sim-clock">
          {snap ? fmtSimTime(snap.simTimeS) : "--:--.-"}
          <span className={snap?.paused ? "paused" : "live"}>{snap?.paused ? "PAUSED" : "LIVE"}</span>
        </div>
        <div className="counters" role="status" aria-label="sector counters">
          {counters.map((c) => (
            <div className={`counter ${c.cls}`} key={c.label} data-counter={c.label.toLowerCase()}>
              <span className="counter-value">{c.value}</span>
              <span className="counter-label">{c.label}</span>
            </div>
          ))}
        </div>
        <div className="view-switch" role="group" aria-label="view mode">
          <button data-testid="view-2d" className={view === "2d" ? "active" : ""} onClick={() => setView("2d")}>
            2D OPS
          </button>
          <button data-testid="view-3d" className={view === "3d" ? "active" : ""} onClick={() => setView("3d")}>
            3D WORLD
          </button>
        </div>
        <div className={`conn ${sim.connected ? "ok" : "down"}`} data-testid="conn">
          {sim.connected ? "STREAM OK" : "RECONNECTING"}
        </div>
      </header>

      <main className="layout">
        <section className="map-wrap" aria-label="sector view">
          {view === "2d" ? (
            <Ops2D frame={sim.frame} selectedId={sim.selectedId} onSelect={sim.select} />
          ) : (
            <Suspense fallback={<div className="view-loading">Loading 3D world…</div>}>
              <World3DView
                frame={sim.frame}
                selectedId={sim.selectedId}
                onSelect={sim.select}
                paused={snap?.paused ?? false}
                simTimeS={snap?.simTimeS ?? 0}
                connected={sim.connected}
                onPause={() =>
                  void act({ type: "pause", paused: !snap?.paused }, snap?.paused ? "Resumed" : "Paused")
                }
                fullscreen={fullscreen}
                onFullscreenChange={setFullscreen}
                onSwitch2D={() => setView("2d")}
              />
            </Suspense>
          )}
          {notice && <div className="notice" role="status">{notice}</div>}
        </section>

        <aside className="panel">
          <section className="card controls" aria-label="controls">
            <h2>Controls</h2>
            <div className="btn-row">
              <button onClick={() => void act({ type: "add-drone", role: "delivery" }, "Delivery drone added")}>+ Delivery <kbd>D</kbd></button>
              <button onClick={() => void act({ type: "add-drone", role: "surveillance" }, "Surveillance drone added")}>+ Surveillance <kbd>V</kbd></button>
            </div>
            <div className="btn-row">
              <button
                className={snap?.weather.length ? "active" : ""}
                onClick={() => void act({ type: "weather", active: !(snap?.weather.length ?? 0 > 0) }, "Weather toggled")}
              >
                {snap?.weather.length ? "Clear weather" : "Simulate weather"} <kbd>W</kbd>
              </button>
              <button onClick={() => void act({ type: "pause", paused: !snap?.paused }, snap?.paused ? "Resumed" : "Paused")}>
                {snap?.paused ? "Resume" : "Pause"} <kbd>Space</kbd>
              </button>
              <button className="danger" onClick={() => void act({ type: "reset" }, "Simulation reset")}>Reset <kbd>R</kbd></button>
            </div>
          </section>

          <section className="card" aria-label="selected drone">
            <h2>Selected aircraft</h2>
            {selected ? <DroneDetails d={selected} onSpoof={(on) => void act({ type: "spoof", droneId: selected.id, on }, on ? "Spoofing injected" : "Spoofing cleared")} onLostLink={(on) => void act({ type: "lost-link", droneId: selected.id, on }, on ? "Link lost - emergency landing" : "Link restored")} /> : <p className="muted">Click a drone on the map to inspect it.</p>}
          </section>

          <section className="card" aria-label="airspace query">
            <h2>4D airspace query</h2>
            <form onSubmit={(e) => void runQuery(e)} className="query">
              <div className="query-grid">
                <label>x0 <input name="x0" type="number" defaultValue={0} /></label>
                <label>y0 <input name="y0" type="number" defaultValue={0} /></label>
                <label>z0 <input name="z0" type="number" defaultValue={0} /></label>
                <label>x1 <input name="x1" type="number" defaultValue={2000} /></label>
                <label>y1 <input name="y1" type="number" defaultValue={1000} /></label>
                <label>z1 <input name="z1" type="number" defaultValue={150} /></label>
                <label>t0 (s) <input name="t0" type="number" defaultValue={-60} /></label>
                <label>t1 (s) <input name="t1" type="number" defaultValue={300} /></label>
              </div>
              <button type="submit" disabled={queryBusy}>{queryBusy ? "Querying…" : "Query cube"}</button>
              {queryResult && (
                <div className="query-result" data-testid="query-result">
                  <p>
                    <strong>{queryResult.matches.length}</strong> aircraft in cube{" "}
                    <span className="mono">[{queryResult.cube.x0},{queryResult.cube.x1}]×[{queryResult.cube.y0},{queryResult.cube.y1}]×[{queryResult.cube.z0},{queryResult.cube.z1}]m</span>{" "}
                    during t∈[{queryResult.cube.t0},{queryResult.cube.t1}]s
                  </p>
                  <ul>
                    {queryResult.matches.map((m) => (
                      <li key={`${m.droneId}-${m.from}-${m.t}`}>
                        <span className="mono">{m.droneId}</span> — {m.from === "contract" ? "planned contract" : "telemetry"} @ t={m.t.toFixed(0)}s
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </form>
          </section>

          <section className="card events" aria-label="event feed">
            <h2>Gateway event feed <span className="muted">(priority ordered)</span></h2>
            <ul className="event-list" data-testid="event-list">
              {sim.events.slice(-30).reverse().map((e) => (
                <li key={e.id} className={PRIORITY_CLASS[e.priority] ?? "p3"}>
                  <span className="ev-pri">{e.priority}</span>
                  <span className="ev-ts">{fmtSimTime(e.ts)}</span>
                  <span className="ev-msg">{e.message}</span>
                </li>
              ))}
              {sim.events.length === 0 && <li className="muted">No events yet…</li>}
            </ul>
          </section>
        </aside>
      </main>

      <div className="sr-live" aria-live="polite">
        {selected ? `${selected.callsign} ${selected.state} battery ${selected.batteryPct} percent` : ""}
      </div>
    </div>
  );
}

function DroneDetails({ d, onSpoof, onLostLink }: { d: DroneView; onSpoof: (on: boolean) => void; onLostLink: (on: boolean) => void }) {
  const battery = Math.max(0, Math.min(100, d.batteryPct));
  return (
    <div className="drone-details" data-testid="drone-details">
      <div className="dd-head">
        <span className={`dd-callsign role-${d.role}`}>{d.callsign}</span>
        <span className="dd-id mono">{d.id}</span>
        <span className={`badge state-${d.state}`}>{d.state}</span>
      </div>
      <dl className="dd-grid">
        <div><dt>Role</dt><dd>{d.role}</dd></div>
        <div><dt>Speed</dt><dd>{d.speedMps} m/s</dd></div>
        <div><dt>Altitude</dt><dd>{d.z} m</dd></div>
        <div><dt>Heading</dt><dd>{d.headingDeg}°</dd></div>
        <div><dt>Deviation</dt><dd className={d.deviationM > 30 ? "warn" : ""}>{d.deviationM} m</dd></div>
        <div><dt>Target</dt><dd>{d.targetLabel ?? "—"}</dd></div>
      </dl>
      <div className="battery">
        <span>Battery</span>
        <div className="bar"><i style={{ width: `${battery}%` }} className={d.flags.criticalBattery ? "critical" : ""} /></div>
        <span className={d.flags.criticalBattery ? "warn" : ""}>{battery.toFixed(0)}%</span>
      </div>
      <div className="trust">
        <span>Fusion trust <em className={d.trust < 0.6 ? "warn" : ""}>{d.trust.toFixed(2)}</em> primary: <em>{d.primarySource}</em></span>
        {d.sources.map((s) => (
          <div className="trust-row" key={s.source}>
            <span className="mono">{s.source}</span>
            <div className="bar"><i style={{ width: `${Math.round(s.trust * 100)}%` }} className={s.trust < 0.5 ? "critical" : ""} /></div>
            <span className="mono">{s.trust.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <div className="dd-flags">
        {d.flags.untrusted && <span className="badge flag-untrusted">UNTRUSTED</span>}
        {d.flags.lostLink && <span className="badge flag-lost">LOST LINK</span>}
        {d.flags.criticalBattery && <span className="badge flag-critical">CRITICAL BATTERY</span>}
        {d.contractStatus && <span className="badge">contract {d.contractStatus}</span>}
      </div>
      <div className="btn-row">
        <button className={d.flags.untrusted ? "active" : ""} onClick={() => onSpoof(!d.flags.untrusted)}>
          {d.flags.untrusted ? "Clear spoof" : "Inject ADS-B spoof"}
        </button>
        <button className={d.flags.lostLink ? "active danger" : ""} onClick={() => onLostLink(!d.flags.lostLink)}>
          {d.flags.lostLink ? "Restore link" : "Simulate lost link"}
        </button>
      </div>
    </div>
  );
}
