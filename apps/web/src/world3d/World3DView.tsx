/**
 * World3DView — thin React wrapper around the imperative World3D scene.
 * Owns the mount lifecycle, feeds frames/selection in, handles 3D-scoped
 * keyboard shortcuts, and overlays the toolbar, compass, hints, HUD (in
 * fullscreen), the FPV game HUD (crosshair, telemetry, minimap), and the
 * WebGL fallback.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { World3D } from "./World3D.js";
import { drawMinimap, type MinimapCam } from "./minimap.js";
import { fmtSimTime } from "../useSimulation.js";
import type { SimFrame } from "./math.js";

export interface World3DViewProps {
  frame: SimFrame | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  paused: boolean;
  simTimeS: number;
  connected: boolean;
  onPause: () => void;
  fullscreen: boolean;
  onFullscreenChange: (on: boolean) => void;
  onSwitch2D: () => void;
  /** FPV key capture state, for the App-level shortcut arbitration. */
  onCaptureChange: (captured: boolean) => void;
}

type GlStatus = "ok" | "unsupported" | "lost";

export default function World3DView(props: World3DViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const compassRef = useRef<HTMLDivElement | null>(null);
  const minimapRef = useRef<HTMLCanvasElement | null>(null);
  const speedRef = useRef<HTMLSpanElement | null>(null);
  const altRef = useRef<HTMLSpanElement | null>(null);
  const hdgRef = useRef<HTMLSpanElement | null>(null);
  const posRef = useRef<HTMLSpanElement | null>(null);
  const lockRef = useRef<HTMLSpanElement | null>(null);
  const tintRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<World3D | null>(null);
  const [status, setStatus] = useState<GlStatus>("ok");
  const [mountKey, setMountKey] = useState(0);
  const [mode, setMode] = useState<"fpv" | "orbit" | "follow">("fpv");
  const [locked, setLocked] = useState(false);
  const lockedRef = useRef(false);
  const capturedRef = useRef(false);
  const [following, setFollowing] = useState<string | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  // Latest frame for the minimap renderer (telemetry callback runs per rAF).
  const frameRef = useRef(props.frame);
  frameRef.current = props.frame;
  const lastMiniSnapRef = useRef<unknown>(null);
  const reducedRef = useRef(false);

  const fpvSupported = useMemo(
    () => typeof document !== "undefined" && "pointerLockElement" in document && window.matchMedia("(pointer: fine)").matches,
    []
  );

  // Mount / dispose the imperative scene.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!World3D.isSupported()) {
      setStatus("unsupported");
      return;
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    reducedRef.current = reduced;
    lockedRef.current = false;
    capturedRef.current = false;
    try {
      const world = new World3D(
        container,
        {
          onSelect: (id) => propsRef.current.onSelect(id),
          onCompass: (deg) => {
            if (compassRef.current) compassRef.current.style.transform = `rotate(${deg}deg)`;
          },
          onStatus: (s) => setStatus(s === "lost" ? "lost" : "ok"),
          onFollowChange: (id) => setFollowing(id),
          onLockChange: (l) => {
            lockedRef.current = l;
            setLocked(l);
          },
          onCaptureChange: (c) => {
            capturedRef.current = c;
            propsRef.current.onCaptureChange(c);
          },
          onModeChange: (m) => setMode(m),
          onFpvTelemetry: (t) => {
            if (speedRef.current) speedRef.current.textContent = `${t.speedMps.toFixed(0)}`;
            if (altRef.current) altRef.current.textContent = `${t.z.toFixed(0)}`;
            if (hdgRef.current) hdgRef.current.textContent = `${Math.round(t.headingDeg)}`;
            if (posRef.current) posRef.current.textContent = `${t.x.toFixed(0)}, ${t.y.toFixed(0)}`;
            if (lockRef.current) lockRef.current.textContent = t.locked ? "LOCKED" : "FREE LOOK";
            if (tintRef.current) tintRef.current.style.opacity = String(Math.min(0.45, t.weatherDepth * 0.45));
            // Minimap: redraw on every telemetry frame, or only on new
            // snapshots under reduced motion.
            const snap = frameRef.current?.current;
            if (snap && minimapRef.current) {
              if (!reducedRef.current || lastMiniSnapRef.current !== snap) {
                lastMiniSnapRef.current = snap;
                const ctx = minimapRef.current.getContext("2d");
                if (ctx) {
                  const cam: MinimapCam = { pos: { x: t.x, y: t.y, z: t.z }, headingDeg: t.headingDeg };
                  drawMinimap(ctx, snap, minimapRef.current.width, minimapRef.current.height, cam, propsRef.current.selectedId);
                }
              }
            }
          },
        },
        { reducedMotion: reduced, fpvSupported }
      );
      worldRef.current = world;
      setStatus("ok");
      setFollowing(null);
      // Restore the current frame and selection after a context-lost remount
      // (these effects do not re-run when only mountKey changes).
      world.setFrame(propsRef.current.frame);
      world.setSelection(propsRef.current.selectedId);
    } catch {
      // WebGL2 probe succeeded but context creation still failed.
      setStatus("unsupported");
      return;
    }
    return () => {
      worldRef.current?.dispose();
      worldRef.current = null;
      propsRef.current.onCaptureChange(false);
    };
    // mountKey only: re-creates the scene after a context-lost restart.
  }, [mountKey]);

  // Feed external state in (no re-mount).
  useEffect(() => {
    worldRef.current?.setFrame(props.frame);
  }, [props.frame]);
  useEffect(() => {
    worldRef.current?.setSelection(props.selectedId);
  }, [props.selectedId]);

  // Redraw the minimap when the frame changes while the camera is still.
  useEffect(() => {
    const snap = props.frame?.current;
    const canvas = minimapRef.current;
    if (!snap || !canvas) return;
    const world = worldRef.current;
    if (!world || world.getCameraInfo().mode !== "fpv") return;
    lastMiniSnapRef.current = snap;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const t = world.lastTelemetry();
    const cam: MinimapCam | null = t ? { pos: { x: t.x, y: t.y, z: t.z }, headingDeg: t.headingDeg } : null;
    drawMinimap(ctx, snap, canvas.width, canvas.height, cam, props.selectedId);
  }, [props.frame, props.selectedId]);

  // 3D-scoped keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const p = propsRef.current;
      if (e.key === "Escape") {
        if (lockedRef.current) return; // browser consumed Esc to release the pointer
        if (p.fullscreen) {
          p.onFullscreenChange(false);
          return;
        }
        const w = worldRef.current;
        if (w?.isFollowing()) {
          w.requestFollow(null);
          return;
        }
        p.onSelect(null);
      } else if (e.key === "f" || e.key === "F") {
        if (e.shiftKey) {
          p.onFullscreenChange(!p.fullscreen);
          return;
        }
        if (p.selectedId) {
          const w = worldRef.current;
          const info = w?.getCameraInfo();
          w?.requestFollow(info && info.mode === "follow" && info.droneId === p.selectedId ? null : p.selectedId);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const followSelected = () => {
    if (!props.selectedId) return;
    const w = worldRef.current;
    const info = w?.getCameraInfo();
    w?.requestFollow(info && info.mode === "follow" && info.droneId === props.selectedId ? null : props.selectedId);
  };

  const isFpv = mode === "fpv";
  const captured = isFpv && locked;

  return (
    <div className={`world3d ${props.fullscreen ? "fullscreen" : ""}`} data-testid="world3d">
      <div ref={containerRef} className="world3d-canvas" />

      {status === "ok" && (
        <>
          <div className="world3d-toolbar">
            <button
              className={mode === "fpv" ? "active" : ""}
              disabled={!fpvSupported}
              onClick={() => worldRef.current?.setFlightMode("fpv")}
              title={fpvSupported ? "First-person spectator flight" : "FPV needs pointer lock (desktop)"}
            >
              FPV
            </button>
            <button
              className={mode === "orbit" ? "active" : ""}
              onClick={() => worldRef.current?.setFlightMode("orbit")}
              title="Overview orbit camera"
            >
              ORBIT
            </button>
            <button
              className={following ? "active" : ""}
              disabled={!props.selectedId}
              onClick={followSelected}
              title="Follow selected aircraft (F)"
            >
              {following ? "FOLLOWING" : "FOLLOW"}
            </button>
            <button onClick={() => props.onFullscreenChange(!props.fullscreen)} title="Toggle fullscreen (Shift+F)">
              {props.fullscreen ? "EXIT FULLSCREEN" : "FULLSCREEN"}
            </button>
          </div>

          {!isFpv && (
            <div className="world3d-compass" aria-hidden="true">
              <div ref={compassRef} className="world3d-needle">
                <span className="n">N</span>
              </div>
            </div>
          )}

          <div className="world3d-hint">
            {mode === "fpv" ? (
              captured ? (
                <span>
                  <kbd>Esc</kbd> release mouse · <kbd>W A S D</kbd> fly · <kbd>Space</kbd> up · <kbd>X</kbd> down ·{" "}
                  <kbd>Shift</kbd> boost · double-click drone: follow
                </span>
              ) : (
                <span>
                  <strong>click: capture mouse</strong> · <kbd>W A S D</kbd> fly · <kbd>Space</kbd> up · <kbd>X</kbd> down ·{" "}
                  <kbd>Shift</kbd> boost · <kbd>F</kbd> follow · <kbd>Shift+F</kbd> fullscreen
                </span>
              )
            ) : (
              <span>drag: orbit · wheel: zoom · right-drag: pan · double-click drone: follow · F: follow · Shift+F: fullscreen</span>
            )}
          </div>

          {isFpv && (
            <>
              <div className="fpv-crosshair" aria-hidden="true">
                <span className="fpv-dot" />
              </div>
              {!captured && (
                <div className="fpv-capture-hint" role="status">
                  CLICK TO CAPTURE MOUSE
                </div>
              )}
              <div className="fpv-tint" ref={tintRef} aria-hidden="true" />
              <div className="fpv-minimap" aria-hidden="true">
                <canvas ref={minimapRef} width={240} height={120} />
                <span className="fpv-minimap-label">MINIMAP</span>
              </div>
              <div className="fpv-telemetry" aria-label="FPV flight telemetry">
                <div className="fpv-row">
                  <span className="fpv-key">SPD</span>
                  <span className="fpv-val"><span ref={speedRef}>0</span> m/s</span>
                </div>
                <div className="fpv-row">
                  <span className="fpv-key">ALT</span>
                  <span className="fpv-val"><span ref={altRef}>0</span> m</span>
                </div>
                <div className="fpv-row">
                  <span className="fpv-key">HDG</span>
                  <span className="fpv-val"><span ref={hdgRef}>0</span>°</span>
                </div>
                <div className="fpv-row">
                  <span className="fpv-key">POS</span>
                  <span className="fpv-val"><span ref={posRef}>—</span></span>
                </div>
                <div className="fpv-row fpv-cam">
                  <span className="fpv-key">CAM</span>
                  <span className="fpv-val" ref={lockRef}>FREE LOOK</span>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {status !== "ok" && (
        <div className="world3d-fallback" data-testid="world3d-fallback">
          <p>
            {status === "unsupported"
              ? "The 3D world view needs WebGL2, which this browser does not provide."
              : "The 3D view lost its graphics context."}
          </p>
          <button onClick={() => (status === "lost" ? setMountKey((k) => k + 1) : props.onSwitch2D())}>
            {status === "lost" ? "Restart 3D view" : "Switch to 2D view"}
          </button>
        </div>
      )}

      {props.fullscreen && status === "ok" && (
        <div className="world3d-hud">
          <span className="hud-brand">UTM · SECTOR A1 — 3D WORLD</span>
          <span className="clock" data-testid="sim-clock">
            {fmtSimTime(props.simTimeS)}
            <span className={props.paused ? "paused" : "live"}>{props.paused ? "PAUSED" : "LIVE"}</span>
          </span>
          <span className={`conn ${props.connected ? "ok" : "down"}`}>{props.connected ? "STREAM OK" : "RECONNECTING"}</span>
          <span className="hud-spacer" />
          <button onClick={props.onPause}>{props.paused ? "Resume" : "Pause"}</button>
          <button onClick={() => props.onFullscreenChange(false)} title="Exit fullscreen (Escape)">
            ✕ exit
          </button>
        </div>
      )}
    </div>
  );
}
