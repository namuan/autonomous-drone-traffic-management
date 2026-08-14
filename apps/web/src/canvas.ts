/**
 * Canvas renderer for the sector view. Top-down 2D projection of the
 * 2000 x 1000 m sector; all coordinates are meters, transformed to pixels
 * here. Pure functions: drawSector() renders, pickDrone() hit-tests.
 */

import type { Snapshot } from "@utm/core";

export interface Viewport {
  scale: number; // px per meter
  ox: number; // origin x in px (sector x=0)
  oy: number;
}

const COLORS = {
  bg: "#0b0f14",
  grid: "rgba(148, 163, 184, 0.10)",
  gridMajor: "rgba(148, 163, 184, 0.16)",
  axis: "rgba(148, 163, 184, 0.45)",
  geofence: "rgba(239, 68, 68, 0.85)",
  geofenceFill: "rgba(239, 68, 68, 0.10)",
  site: "#34d399",
  siteStroke: "rgba(52, 211, 153, 0.5)",
  weather: "rgba(250, 204, 21, 0.85)",
  weatherFill: "rgba(250, 204, 21, 0.12)",
  delivery: "#38bdf8",
  surveillance: "#c084fc",
  deliveryDim: "rgba(56, 189, 248, 0.35)",
  surveillanceDim: "rgba(192, 132, 252, 0.35)",
  trail: "rgba(148, 163, 184, 0.35)",
  route: "rgba(148, 163, 184, 0.28)",
  link: "rgba(100, 116, 139, 0.35)",
  critical: "#f87171",
  untrusted: "#fb923c",
  lost: "#9ca3af",
  select: "#f8fafc",
  text: "#cbd5e1",
  reroute: "#fde047",
} as const;

export function computeViewport(width: number, height: number, snap: Snapshot): Viewport {
  const pad = 46;
  const scale = Math.min((width - pad * 2) / snap.sector.widthM, (height - pad * 2) / snap.sector.heightM);
  const ox = (width - snap.sector.widthM * scale) / 2;
  const oy = (height - snap.sector.heightM * scale) / 2;
  return { scale, ox, oy };
}

const px = (m: number, vp: Viewport) => vp.ox + m * vp.scale;
const py = (m: number, vp: Viewport) => vp.oy + m * vp.scale;

export function drawSector(
  ctx: CanvasRenderingContext2D,
  snap: Snapshot,
  vp: Viewport,
  selectedId: string | null,
  alpha = 1
): void {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.globalAlpha = alpha;

  // Background + grid.
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.lineWidth = 1;
  const gridStep = 100;
  for (let gx = 0; gx <= snap.sector.widthM; gx += gridStep) {
    ctx.strokeStyle = gx % 500 === 0 ? COLORS.gridMajor : COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(px(gx, vp), py(0, vp));
    ctx.lineTo(px(gx, vp), py(snap.sector.heightM, vp));
    ctx.stroke();
  }
  for (let gy = 0; gy <= snap.sector.heightM; gy += gridStep) {
    ctx.strokeStyle = gy % 500 === 0 ? COLORS.gridMajor : COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(px(0, vp), py(gy, vp));
    ctx.lineTo(px(snap.sector.widthM, vp), py(gy, vp));
    ctx.stroke();
  }

  // Axis labels.
  ctx.fillStyle = COLORS.axis;
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  for (let gx = 0; gx <= snap.sector.widthM; gx += 500) {
    ctx.fillText(`${gx}m`, px(gx, vp), py(snap.sector.heightM, vp) + 16);
  }
  ctx.textAlign = "right";
  for (let gy = 0; gy <= snap.sector.heightM; gy += 500) {
    ctx.fillText(`${gy}m`, px(0, vp) - 8, py(gy, vp) + 3);
  }

  // Geofences.
  for (const gf of snap.geofences) {
    const x = px(gf.rect.x, vp);
    const y = py(gf.rect.y, vp);
    const w = gf.rect.w * vp.scale;
    const h = gf.rect.h * vp.scale;
    ctx.fillStyle = COLORS.geofenceFill;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = COLORS.geofence;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.geofence;
    ctx.textAlign = "left";
    ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(`NO-FLY ${gf.name}`, x + 6, y + 12);
  }

  // Landing sites.
  for (const site of snap.landingSites) {
    const x = px(site.pos.x, vp);
    const y = py(site.pos.y, vp);
    ctx.strokeStyle = COLORS.siteStroke;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.site;
    ctx.fill();
    ctx.fillStyle = COLORS.site;
    ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.fillText(site.name, x, y - 14);
  }

  // Weather zones (pulsing).
  for (const wz of snap.weather) {
    const x = px(wz.center.x, vp);
    const y = py(wz.center.y, vp);
    const r = Math.max(6, wz.radius * vp.scale);
    const pulse = 0.85 + 0.15 * Math.sin(wz.phase);
    const grad = ctx.createRadialGradient(x, y, r * 0.2, x, y, r);
    grad.addColorStop(0, `rgba(250, 204, 21, ${0.28 * wz.intensity * pulse})`);
    grad.addColorStop(1, "rgba(250, 204, 21, 0.02)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(250, 204, 21, ${0.55 * wz.intensity})`;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(250, 204, 21, 0.8)";
    ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.fillText(`TURB ${Math.round(wz.radius)}m`, x, y - r - 4);
  }

  // Mesh links.
  for (const link of snap.meshLinks) {
    const a = snap.drones.find((d) => d.id === link.a);
    const b = snap.drones.find((d) => d.id === link.b);
    if (!a || !b) continue;
    ctx.strokeStyle = COLORS.link;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px(a.x, vp), py(a.y, vp));
    ctx.lineTo(px(b.x, vp), py(b.y, vp));
    ctx.stroke();
  }

  // Planned routes + trails + drones.
  for (const d of snap.drones) {
    const x = px(d.x, vp);
    const y = py(d.y, vp);
    const roleColor = d.role === "delivery" ? COLORS.delivery : COLORS.surveillance;

    // Planned route polyline.
    if (d.route.length > 1) {
      ctx.strokeStyle = COLORS.route;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(px(d.route[0].x, vp), py(d.route[0].y, vp));
      for (const p of d.route.slice(1)) ctx.lineTo(px(p.x, vp), py(p.y, vp));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Trail (fading by recency).
    if (d.trail.length > 1) {
      ctx.strokeStyle = COLORS.trail;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(px(d.trail[0].x, vp), py(d.trail[0].y, vp));
      for (const p of d.trail.slice(1)) ctx.lineTo(px(p.x, vp), py(p.y, vp));
      ctx.stroke();
    }

    // Detection radius.
    const r18 = 18 * vp.scale;
    ctx.strokeStyle = d.role === "delivery" ? COLORS.deliveryDim : COLORS.surveillanceDim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, r18, 0, Math.PI * 2);
    ctx.stroke();

    // Drone body.
    const r = Math.max(3.5, 4.2 * vp.scale * (d.flags.untrusted || d.flags.criticalBattery || d.flags.lostLink ? 1.25 : 1));
    ctx.fillStyle = roleColor;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    // Heading tick.
    const hd = (d.headingDeg * Math.PI) / 180;
    ctx.strokeStyle = COLORS.select;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(hd) * (r + 3), y + Math.sin(hd) * (r + 3));
    ctx.stroke();

    // State rings.
    if (d.id === selectedId) {
      ctx.strokeStyle = COLORS.select;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (d.flags.criticalBattery) {
      ctx.strokeStyle = COLORS.critical;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (d.flags.untrusted) {
      ctx.strokeStyle = COLORS.untrusted;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(x, y, r + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (d.flags.lostLink) {
      ctx.strokeStyle = COLORS.lost;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r + 9, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (d.state === "rerouting") {
      ctx.strokeStyle = COLORS.reroute;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(x, y, r + 8, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Callsign label.
    ctx.fillStyle = COLORS.text;
    ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.fillText(d.callsign, x + r + 4, y - r - 2);
  }

  ctx.restore();
}

/** Hit-test: which drone is at canvas pixel (mx, my)? */
export function pickDrone(snap: Snapshot, vp: Viewport, mx: number, my: number): string | null {
  let best: string | null = null;
  let bestD = 400; // px threshold
  for (const d of snap.drones) {
    const x = px(d.x, vp);
    const y = py(d.y, vp);
    const dist = Math.hypot(mx - x, my - y);
    if (dist < bestD) {
      bestD = dist;
      best = d.id;
    }
  }
  return best;
}

export const ROLE_LABEL: Record<string, string> = { delivery: "delivery", surveillance: "surveillance" };
