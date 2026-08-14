/**
 * Ops2D — the top-down 2D operations console view, extracted from App so the
 * 2D and 3D views can be mounted exclusively (one render loop active at a
 * time). Rendering behavior is identical to the original inline loop.
 */

import { useEffect, useRef } from "react";
import { computeViewport, drawSector, pickDrone } from "../canvas.js";
import type { SimFrame } from "../world3d/math.js";

export interface Ops2DProps {
  frame: SimFrame | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export default function Ops2D({ frame, selectedId, onSelect }: Ops2DProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let lastSnap = frame?.current ?? null;
    const render = () => {
      const snap = frame?.current ?? null;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (snap) {
        const vp = computeViewport(w, h, snap);
        let alpha = 1;
        if (!reduced && lastSnap && lastSnap !== snap && frame && frame.receivedAtMs > 0) {
          const dt = performance.now() - frame.receivedAtMs;
          alpha = Math.max(0, Math.min(1, 1 - dt / 100));
        }
        drawSector(ctx, snap, vp, selectedId, alpha);
        lastSnap = snap;
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [frame, selectedId]);

  return (
    <>
      <canvas
        ref={canvasRef}
        data-testid="sector-canvas"
        role="img"
        aria-label="Top-down map of sector A1: geofences, landing sites, weather, drones with trails and mesh links"
        onClick={(e) => {
          const canvas = canvasRef.current;
          if (!canvas || !frame) return;
          const rect = canvas.getBoundingClientRect();
          const vp = computeViewport(rect.width, rect.height, frame.current);
          const id = pickDrone(frame.current, vp, e.clientX - rect.left, e.clientY - rect.top);
          onSelect(id);
        }}
      />
      <div className="legend">
        <span><i className="dot delivery" /> delivery</span>
        <span><i className="dot surveillance" /> surveillance</span>
        <span><i className="dot weather" /> turbulence</span>
        <span><i className="dot nofly" /> no-fly zone</span>
        <span><i className="dot mesh" /> mesh link</span>
      </div>
    </>
  );
}
