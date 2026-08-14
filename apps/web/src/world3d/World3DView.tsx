/**
 * World3DView — thin React wrapper around the imperative World3D scene.
 * Owns the mount lifecycle, feeds frames/selection in, handles 3D-scoped
 * keyboard shortcuts, and overlays the toolbar, compass, hints, HUD (in
 * fullscreen), and the WebGL fallback.
 */

import { useEffect, useRef, useState } from "react";
import { World3D } from "./World3D.js";
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
}

type GlStatus = "ok" | "unsupported" | "lost";

export default function World3DView(props: World3DViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const compassRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<World3D | null>(null);
  const [status, setStatus] = useState<GlStatus>("ok");
  const [mountKey, setMountKey] = useState(0);
  const [following, setFollowing] = useState<string | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  // Mount / dispose the imperative scene.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!World3D.isSupported()) {
      setStatus("unsupported");
      return;
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
        },
        { reducedMotion: reduced }
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

  // 3D-scoped keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const p = propsRef.current;
      if (e.key === "Escape") {
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

  return (
    <div className={`world3d ${props.fullscreen ? "fullscreen" : ""}`} data-testid="world3d">
      <div ref={containerRef} className="world3d-canvas" />

      {status === "ok" && (
        <>
          <div className="world3d-toolbar">
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
          <div className="world3d-compass" aria-hidden="true">
            <div ref={compassRef} className="world3d-needle">
              <span className="n">N</span>
            </div>
          </div>
          <div className="world3d-hint">
            drag: orbit · wheel: zoom · right-drag: pan · double-click drone: follow · F: follow · Shift+F: fullscreen
          </div>
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
