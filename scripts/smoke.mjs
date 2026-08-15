/**
 * Browser smoke test: starts the production server (API + static web) and
 * drives a real Chromium via playwright-core. Verifies the console loads,
 * streams state over WebSocket, responds to commands, and renders the canvas.
 *
 * Usage: pnpm build && pnpm e2e   (or: node scripts/smoke.mjs)
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = new URL("..", import.meta.url).pathname;

function findChromium() {
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  if (!existsSync(cache)) return null;
  for (const dir of readdirSync(cache)) {
    const candidates = [
      join(cache, dir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      join(cache, dir, "chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"),
      join(cache, dir, "headless_shell-mac-arm64", "headless_shell"),
      join(cache, dir, "chromium_headless_shell-mac-arm64", "chromium_headless_shell"),
    ];
    for (const c of candidates) if (existsSync(c)) return c;
  }
  return null;
}

async function waitFor(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const server = spawn("node", [join(ROOT, "apps/api/dist/server.js")], {
  env: { ...process.env, PORT: String(PORT), WEB_DIST: join(ROOT, "apps/web/dist") },
  stdio: ["ignore", "pipe", "pipe"],
});

let exitCode = 1;
try {
  await waitFor(`${BASE}/health`);
  console.log("server up");

  const health = await (await fetch(`${BASE}/health`)).json();
  check("health endpoint", health.status === "ok" && typeof health.tick === "number", `tick=${health.tick}`);

  const execPath = findChromium();
  if (!execPath) throw new Error("No Playwright Chromium found in cache");
  const browser = await chromium.launch({ executablePath: execPath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await page.goto(BASE, { waitUntil: "networkidle" });

  // Console loads and connects.
  await page.waitForSelector('[data-testid="sector-canvas"]', { timeout: 10000 });
  await page.waitForSelector('[data-testid="conn"].ok', { timeout: 15000 });
  check("console loads and WS connects", true);

  // Live clock advances (snapshots streaming).
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="sim-clock"]');
      return el && el.textContent && !el.textContent.startsWith("--");
    },
    { timeout: 10000 }
  );
  const clock1 = await page.textContent('[data-testid="sim-clock"]');
  await new Promise((r) => setTimeout(r, 1500));
  const clock2 = await page.textContent('[data-testid="sim-clock"]');
  check("sim clock advances", clock1 !== clock2, `${clock1?.trim()} -> ${clock2?.trim()}`);

  // Counters reflect activity.
  await page.waitForFunction(
    () => Number(document.querySelector('[data-counter="contracts"] .counter-value')?.textContent) > 0,
    { timeout: 20000 }
  );
  check("contract counter > 0", true);

  // Command: add a delivery drone -> drone count increases.
  const before = await page.textContent('[data-counter="active"] .counter-value');
  await page.click("text=+ Delivery");
  await page.waitForFunction(
    (prev) => Number(document.querySelector('[data-counter="active"] .counter-value')?.textContent) > Number(prev),
    before,
    { timeout: 15000 }
  );
  check("add-drone command reflected in counters", true, `${before} -> ${await page.textContent('[data-counter="active"] .counter-value')}`);

  // Command: weather -> weather zones appear (via REST -> engine -> WS snapshot).
  await page.click("text=Simulate weather");
  await page.waitForFunction(
    () => {
      const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Clear weather"));
      return !!btn;
    },
    { timeout: 20000 }
  );
  check("weather command reflected in UI", true);

  // Select a drone by clicking the canvas.
  await page.waitForFunction(() => document.querySelectorAll("canvas")[0] !== null);
  const clicked = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const r = canvas.getBoundingClientRect();
    // Click a few spots; the first drone found becomes selected.
    for (const fx of [0.3, 0.5, 0.7]) {
      for (const fy of [0.3, 0.5, 0.7]) {
        canvas.dispatchEvent(new MouseEvent("click", { clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, bubbles: true }));
      }
    }
    return true;
  });
  void clicked;
  const selected = await page.waitForSelector('[data-testid="drone-details"]', { timeout: 5000 }).catch(() => null);
  check("drone selection works", selected !== null);

  // Query tool roundtrip.
  await page.click("button:has-text('Query cube')");
  await page.waitForSelector('[data-testid="query-result"]', { timeout: 10000 });
  const qtext = await page.textContent('[data-testid="query-result"]');
  check("4D airspace query works", (qtext ?? "").includes("aircraft in cube"), qtext?.split("\n")[0]?.trim());

  // Event feed populated.
  const eventCount = await page.evaluate(() => document.querySelectorAll('[data-testid="event-list"] li').length);
  check("event feed populated", eventCount > 0, `${eventCount} events`);

  // ----------------------------------------------------- 3D world view
  await page.click('[data-testid="view-3d"]');
  const webgl2 = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));

  if (!webgl2) {
    // Headless environments often lack GPU-backed WebGL2: verify the graceful
    // fallback path instead (the app must never silently claim 3D is active).
    await page.waitForSelector('[data-testid="world3d-fallback"]', { timeout: 15000 });
    check("3D view shows WebGL fallback when WebGL2 is unavailable", true);
    await page.click('[data-testid="world3d-fallback"] button');
    await page.waitForSelector('[data-testid="sector-canvas"]', { timeout: 10000 });
    check("fallback 'Switch to 2D' returns to console", true);
    await page.screenshot({ path: join(ROOT, "artifacts/world3d-fallback.png"), fullPage: false });
  } else {
    await page.waitForSelector('[data-testid="world3d"] canvas', { timeout: 15000 });
    check("3D world view mounts WebGL canvas", true);

    // Make sure a drone is selected deterministically before switching views.
    if (!selected) {
      await page.evaluate(() => {
        const canvas = document.querySelector("canvas");
        const r = canvas.getBoundingClientRect();
        for (const fx of [0.3, 0.5, 0.7]) {
          for (const fy of [0.3, 0.5, 0.7]) {
            canvas.dispatchEvent(new MouseEvent("click", { clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, bubbles: true }));
          }
        }
      });
      await page.keyboard.press("Escape"); // release any pointer lock the clicks acquired
      await page.waitForSelector('[data-testid="drone-details"]', { timeout: 5000 }).catch(() => null);
    }
    const panel3d = await page.locator('[data-testid="drone-details"]').count();
    check("selection persists into 3D view", panel3d === 1);

    // FPV is the default camera mode with its game HUD.
    const fpvBtn = await page.locator('.world3d-toolbar button:has-text("FPV")').getAttribute("class");
    check("FPV is the default 3D camera mode", (fpvBtn ?? "").includes("active"));
    await page.waitForSelector(".fpv-telemetry", { timeout: 5000 });
    const hudOk =
      (await page.locator(".fpv-telemetry").count()) === 1 &&
      (await page.locator(".fpv-minimap canvas").count()) === 1 &&
      (await page.locator(".fpv-crosshair").count()) === 1;
    check("FPV game HUD (telemetry, minimap, crosshair) present", hudOk);

    // Mode switching: orbit shows the compass, FPV returns the HUD.
    await page.click('.world3d-toolbar button:has-text("ORBIT")');
    await page.waitForSelector(".world3d-compass", { timeout: 5000 });
    check("ORBIT mode switch returns compass", true);
    await page.click('.world3d-toolbar button:has-text("FPV")');
    await page.waitForSelector(".fpv-telemetry", { timeout: 5000 });
    check("switch back to FPV mode", true);

    // Fullscreen overlay engages and exits.
    await page.click('.world3d-toolbar button:has-text("FULLSCREEN")');
    await page.waitForSelector(".world3d.fullscreen", { timeout: 5000 });
    check("3D fullscreen overlay engages", true);
    await page.click('.world3d-hud button:has-text("exit")');
    await page.waitForSelector(".world3d:not(.fullscreen)", { timeout: 5000 });
    check("3D fullscreen exits", true);

    // Screenshot the 3D world for the record.
    await page.screenshot({ path: join(ROOT, "artifacts/world3d.png"), fullPage: false });

    // Back to the 2D console.
    await page.click('[data-testid="view-2d"]');
    await page.waitForSelector('[data-testid="sector-canvas"]', { timeout: 10000 });
    check("switch back to 2D view", true);
  }

  check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

  // Screenshot for the record.
  mkdirSync(join(ROOT, "artifacts"), { recursive: true });
  await page.screenshot({ path: join(ROOT, "artifacts/console.png"), fullPage: false });
  console.log("screenshot -> artifacts/console.png");

  await browser.close();
  exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (err) {
  console.error("SMOKE TEST ERROR:", err instanceof Error ? err.message : err);
  exitCode = 1;
} finally {
  server.kill("SIGTERM");
}

process.exit(exitCode);
