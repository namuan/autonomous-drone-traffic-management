/**
 * Lightweight minimap for the FPV HUD. Deliberately does NOT reuse the full
 * ops-console renderer (its fixed 9-10 px labels and dense grid would clutter
 * a 240 x 120 canvas). Shares the coordinate conventions instead: sector x ->
 * screen right, sector y -> screen down, so the map matches the top-down
 * view. FPV heading 0 (+Z = north = sector +y) therefore points screen-down;
 * see cameraMarkerRotation in math.ts.
 */

import type { Snapshot } from "@utm/core";
import { ROLE_HEX_STR, cameraMarkerRotation, type Vec3 } from "./math.js";

export const MINIMAP_PAD = 8;

export interface MinimapCam {
  /** Sector-frame position of the camera. */
  pos: Vec3;
  headingDeg: number;
}

export function minimapTransform(w: number, h: number, sectorW: number, sectorH: number): { scale: number; ox: number; oy: number } {
  const scale = Math.min((w - MINIMAP_PAD * 2) / sectorW, (h - MINIMAP_PAD * 2) / sectorH);
  return { scale, ox: (w - sectorW * scale) / 2, oy: (h - sectorH * scale) / 2 };
}

export function worldToMinimap(x: number, y: number, w: number, h: number, sectorW: number, sectorH: number): { x: number; y: number } {
  const t = minimapTransform(w, h, sectorW, sectorH);
  return { x: t.ox + x * t.scale, y: t.oy + y * t.scale };
}

export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  snap: Snapshot,
  w: number,
  h: number,
  cam: MinimapCam | null,
  selectedId: string | null
): void {
  const { widthM: W, heightM: H } = snap.sector;
  const t = minimapTransform(w, h, W, H);

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(10, 14, 19, 0.85)";
  ctx.fillRect(0, 0, w, h);

  // Sparse 250 m grid.
  ctx.strokeStyle = "rgba(148, 163, 184, 0.14)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = 0; gx <= W; gx += 250) {
    const p = worldToMinimap(gx, 0, w, h, W, H);
    ctx.moveTo(p.x, t.oy);
    ctx.lineTo(p.x, t.oy + H * t.scale);
  }
  for (let gy = 0; gy <= H; gy += 250) {
    const p = worldToMinimap(0, gy, w, h, W, H);
    ctx.moveTo(t.ox, p.y);
    ctx.lineTo(t.ox + W * t.scale, p.y);
  }
  ctx.stroke();

  // Sector border.
  ctx.strokeStyle = "rgba(148, 163, 184, 0.55)";
  ctx.strokeRect(t.ox, t.oy, W * t.scale, H * t.scale);

  // Geofences.
  for (const gf of snap.geofences) {
    const a = worldToMinimap(gf.rect.x, gf.rect.y, w, h, W, H);
    const b = worldToMinimap(gf.rect.x + gf.rect.w, gf.rect.y + gf.rect.h, w, h, W, H);
    ctx.fillStyle = "rgba(239, 68, 68, 0.22)";
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeStyle = "rgba(239, 68, 68, 0.85)";
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  }

  // Weather cells.
  for (const wz of snap.weather) {
    const p = worldToMinimap(wz.center.x, wz.center.y, w, h, W, H);
    const r = Math.max(3, wz.radius * t.scale);
    ctx.fillStyle = "rgba(250, 204, 21, 0.30)";
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(250, 204, 21, 0.7)";
    ctx.stroke();
  }

  // Landing sites.
  for (const site of snap.landingSites) {
    const p = worldToMinimap(site.pos.x, site.pos.y, w, h, W, H);
    ctx.strokeStyle = "rgba(52, 211, 153, 0.8)";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Drones.
  for (const d of snap.drones) {
    const p = worldToMinimap(d.x, d.y, w, h, W, H);
    ctx.fillStyle = ROLE_HEX_STR[d.role];
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
    if (d.id === selectedId) {
      ctx.strokeStyle = "#f8fafc";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  // Camera marker.
  if (cam) {
    const p = worldToMinimap(cam.pos.x, cam.pos.y, w, h, W, H);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(cameraMarkerRotation(cam.headingDeg));
    ctx.fillStyle = "#e2e8f0";
    ctx.strokeStyle = "rgba(226, 232, 240, 0.9)";
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(4.5, 5);
    ctx.lineTo(-4.5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
