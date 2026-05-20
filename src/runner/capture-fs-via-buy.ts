/**
 * Phase 2.6 — Capture Free Spin chain via Buy Feature.
 *
 * Game có Buy Feature (vd Gates of Olympus, Sweet Bonanza, Sugar Rush) cho
 * phép user mua trigger FS với 100× bet → deterministic 100% trigger rate.
 * Lợi dụng để capture FS chain mà KHÔNG phụ thuộc RNG demo server.
 *
 * Flow:
 *   1. Mở browser, pre-game ready
 *   2. LLM-guided: click "Buy Free Spins" → confirm 100×
 *   3. Listen network — game tự auto-spin chain (15+ FS frame)
 *   4. Track `fs` field giảm dần: 15 → 14 → ... → 0
 *   5. Khi fs=0 hoặc timeout 60s → save chain
 *
 * Output:
 *   fixtures/scenarios/{slug}/free_spin_chain.json (multi-frame)
 *
 * Khác Phase 2.5:
 *   - Phase 2.5 capture click sequence (cho replay deterministic test)
 *   - Phase 2.6 capture network responses (cho mock free_spins test)
 *   - Có thể chạy chung 1 session: click buy → record clicks (2.5) +
 *     simultaneously listen network (2.6) — nhưng tách module để modular.
 */

import { chromium, type Page, type Response } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { askClaude } from "../ai/claude.js";
import { preGameWithReplayOrVision } from "./pre-game-replay.js";
import {
  scenarioPath,
  saveScenario,
  type Scenario,
  type SpinResponseFixture,
} from "./scenario.js";
import { getSpinUrlPattern } from "./spin-detect.js";

const VIEWPORT = { width: 1440, height: 900 };
const SPIN_PATTERN = getSpinUrlPattern();

export type CaptureFsViaBuyOpts = {
  slug: string;
  gameUrl: string;
  /** Force re-capture dù scenario đã có. Default false. */
  overwrite?: boolean;
  headless?: boolean;
  /** Max ms chờ FS chain end. Default 180000 (180s — full 15 FS chain ~120s). */
  fsChainTimeoutMs?: number;
  /** No new spin response trong N ms → declare chain end. Default 15000 (15s
   *  — cover cascade animation 6-10s/FS với buffer). Quá ngắn → chain end sớm. */
  fsChainIdleMs?: number;
};

export type CaptureFsViaBuyResult = {
  ok: boolean;
  reason: string;
  framesCaptured: number;
  scenarioPath?: string;
  durationMs: number;
};

/** Heuristic: detect FS state từ parsed response body. Cùng logic discoverFreeSpinChain. */
function detectFreeSpinState(parsed: Record<string, unknown>): boolean {
  if (parsed.isFreeSpin === true) return true;
  for (const k of ["winFreeSpins", "freeSpins", "fs", "free_spins"]) {
    const v = Number(parsed[k] ?? 0);
    if (Number.isFinite(v) && v > 0) return true;
  }
  if (typeof parsed.gs === "string" && parsed.gs.length > 0) return true;
  const bl = Number(parsed.bl ?? 0);
  if (Number.isFinite(bl) && bl > 0) return true;
  const na = String(parsed.na ?? "");
  if (/^fs/i.test(na)) return true;
  return false;
}

/** Try parse PP querystring body OR JSON body. */
function tryParseBody(text: string): Record<string, unknown> | null {
  if (!text) return null;
  // JSON first
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object") return obj as Record<string, unknown>;
  } catch {}
  // Querystring
  try {
    const params = new URLSearchParams(text);
    const out: Record<string, unknown> = {};
    for (const [k, v] of params) out[k] = v;
    return Object.keys(out).length > 0 ? out : null;
  } catch {}
  return null;
}

/** LLM-guided click cho 1 instruction. Cùng logic case-action.ts decideClickForInstruction. */
async function decideClick(
  screenshotB64: string,
  instruction: string,
  viewport: { width: number; height: number },
): Promise<{ x: number; y: number; done: boolean; reason: string }> {
  const system = `You guide canvas slot game tests by returning click coordinates as JSON.`;
  const prompt = `Task: "${instruction}"

Viewport: ${viewport.width}×${viewport.height} pixels (origin top-left).

Look at screenshot. Return JSON ONLY (no markdown):
{"x": <int>, "y": <int>, "done": <bool>, "reason": "<short>"}

If task already satisfied (vd buy popup already open and you see confirm button next, this is current step) → click that.
If no click needed at all (task complete) → {"x":0,"y":0,"done":true,"reason":"..."}.`;
  const raw = await askClaude({
    system,
    content: [
      { type: "text", text: prompt },
      { type: "image", source: { type: "base64", media_type: "image/png", data: screenshotB64 } },
    ],
    label: "capture-fs-via-buy",
  });
  const m = raw.match(/\{[\s\S]*?\}/);
  if (!m) throw new Error(`No JSON: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(m[0]) as { x?: number; y?: number; done?: boolean; reason?: string };
  return {
    x: Math.round(Number(parsed.x ?? 0)),
    y: Math.round(Number(parsed.y ?? 0)),
    done: Boolean(parsed.done),
    reason: String(parsed.reason ?? instruction).slice(0, 100),
  };
}

export async function captureFsViaBuy(
  opts: CaptureFsViaBuyOpts,
): Promise<CaptureFsViaBuyResult> {
  const t0 = Date.now();
  const timeoutMs = opts.fsChainTimeoutMs ?? 180_000;
  const idleMs = opts.fsChainIdleMs ?? 15_000;
  const target = scenarioPath(opts.slug, "free_spin_chain");

  if (existsSync(target) && !opts.overwrite) {
    return {
      ok: false,
      reason: `scenario exists at ${target} (use --overwrite to refresh)`,
      framesCaptured: 0,
      durationMs: Date.now() - t0,
    };
  }

  console.log("================================================================");
  console.log(` PHASE 2.6: Capture FS chain via Buy Feature — ${opts.slug}`);
  console.log(` Timeout: ${timeoutMs / 1000}s, idle threshold: ${idleMs / 1000}s`);
  console.log(` End conditions: fs===fsmax (PP completed mode) OR isFs=false (base game) OR idle timeout`);
  console.log("================================================================");

  const browser = await chromium.launch({
    headless: opts.headless ?? false,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();

  // ===== Network listener — start before any click =====
  const capturedFrames: SpinResponseFixture[] = [];
  let lastResponseAt = Date.now();
  let chainStarted = false;
  let chainEnded = false;
  let fsMaxObserved = 0; // PP `fsmax` field — total FS expected (vd 15 cho Gates of Olympus buy)
  let fsCurrentMax = 0;  // Highest `fs` seen so far — track FS counter progress

  page.on("response", async (res: Response) => {
    try {
      if (!SPIN_PATTERN.test(res.url())) return;
      if (res.request().method() !== "POST") return;
      const text = await res.text().catch(() => "");
      if (!text) return;
      const parsed = tryParseBody(text);
      if (!parsed) return;
      const isFs = detectFreeSpinState(parsed);
      lastResponseAt = Date.now();
      // Track FS progress
      const fsVal = Number(parsed.fs ?? 0);
      const fsMaxVal = Number(parsed.fsmax ?? 0);
      if (Number.isFinite(fsVal) && fsVal > fsCurrentMax) fsCurrentMax = fsVal;
      if (Number.isFinite(fsMaxVal) && fsMaxVal > fsMaxObserved) fsMaxObserved = fsMaxVal;

      if (!chainStarted) {
        // First FS response → chain started
        if (isFs) {
          chainStarted = true;
          console.log(`[capture-fs] ★ chain started (frame 1, fs=${parsed.fs ?? "?"}/${fsMaxObserved})`);
          capturedFrames.push({
            url: res.url(),
            url_pattern: SPIN_PATTERN.source,
            method: "POST",
            status: res.status(),
            headers: { "content-type": "text/plain; charset=ISO-8859-1" },
            body: text,
            parsed,
          });
        }
        // Pre-FS responses (vd doInit, base game spin trước buy) → skip
      } else {
        // Already in chain
        capturedFrames.push({
          url: res.url(),
          url_pattern: SPIN_PATTERN.source,
          method: "POST",
          status: res.status(),
          headers: { "content-type": "text/plain; charset=ISO-8859-1" },
          body: text,
          parsed,
        });
        console.log(
          `[capture-fs] frame ${capturedFrames.length} captured (fs=${parsed.fs ?? "0"}/${fsMaxObserved}, tw=${parsed.tw ?? "?"})`,
        );
        if (!isFs) {
          // Response không còn FS marker → game đã về base → chain end
          chainEnded = true;
          console.log(`[capture-fs] ✓ chain end detected (base game response in frame ${capturedFrames.length})`);
        } else if (
          fsMaxObserved > 0 &&
          Number.isFinite(fsVal) &&
          fsVal >= fsMaxObserved
        ) {
          // PP "completed counter" mode: fs đếm tăng dần từ 1 → fsmax. Khi
          // fs === fsmax, FS round đã hoàn thành tất cả spin → chain end.
          // (vs20olympgate / Gates of Olympus dùng convention này).
          chainEnded = true;
          console.log(
            `[capture-fs] ✓ chain end detected (fs=${fsVal} reached fsmax=${fsMaxObserved} in frame ${capturedFrames.length})`,
          );
        }
      }
    } catch {}
  });

  try {
    await page.goto(opts.gameUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2_000);

    const ready = await preGameWithReplayOrVision(page, {
      slug: opts.slug,
      viewport: VIEWPORT,
      label: `pregame-capture-fs-buy`,
    });
    if (!ready.ready) {
      return {
        ok: false,
        reason: `pre-game không ready (${ready.source})`,
        framesCaptured: 0,
        durationMs: Date.now() - t0,
      };
    }

    // ===== Dismiss leftover modal (state contamination từ run trước) =====
    // Phase 2.6 fail giữa chừng → modal "Congratulations $X won" stay nguyên.
    // Brute-force keyboard + center click (PP modals all accept "press anywhere"),
    // LLM fallback chỉ khi vẫn stuck.
    try {
      console.log(`[capture-fs] Brute-force dismiss any leftover modal...`);
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Space").catch(() => {});
        await page.waitForTimeout(800);
        await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2);
        await page.waitForTimeout(1_500);
      }
      // LLM check chỉ để verify state clean (1 call probe, không loop)
      const probeShot = await page.screenshot({ type: "png" });
      const probe = await decideClick(
        probeShot.toString("base64"),
        "Is game UI clean? (Buy Feature button visible on left + Spin button visible bottom-right + no overlay modal). If clean → done=true. If still modal → click center area to dismiss.",
        VIEWPORT,
      );
      if (probe.done) {
        console.log(`[capture-fs] ✓ game state clean after brute dismiss`);
      } else if (probe.x > 0 && probe.y > 0) {
        await page.mouse.click(probe.x, probe.y);
        console.log(`[capture-fs] LLM-guided cleanup click @ (${probe.x},${probe.y}) — ${probe.reason}`);
        await page.waitForTimeout(2_500);
      }
    } catch (err) {
      console.warn(`[capture-fs] leftover-modal probe failed (non-fatal): ${(err as Error).message}`);
    }

    // ===== LLM click Buy → Confirm =====
    const instructions = [
      "click the 'Buy Free Spins' button (usually shows '100x bet' label on left/bottom side of game UI)",
      "click the confirm/buy button in the popup to commit the 100x purchase and trigger free spins",
    ];
    const debugDir = join("fixtures/case-actions", opts.slug, "_debug-capture-fs");
    mkdirSync(debugDir, { recursive: true });
    for (let i = 0; i < instructions.length; i++) {
      const instruction = instructions[i]!;
      const shot = await page.screenshot({ type: "png" });
      // Save LLM-input screenshot for debugging — invaluable khi LLM trả (0,0).
      const shotPath = join(debugDir, `step-${i + 1}-input-${Date.now()}.png`);
      writeFileSync(shotPath, shot);
      const decision = await decideClick(
        shot.toString("base64"),
        instruction,
        VIEWPORT,
      );
      console.log(
        `[capture-fs] step ${i + 1}/${instructions.length}: "${instruction.slice(0, 60)}..." → ${decision.done ? "DONE" : `click (${decision.x},${decision.y})`} (reason: ${decision.reason})`,
      );
      console.log(`[capture-fs]   screenshot: ${shotPath}`);
      if (decision.done) continue;
      if (decision.x <= 0 || decision.y <= 0) {
        return {
          ok: false,
          reason: `step ${i + 1}: invalid coord (${decision.x},${decision.y}) — LLM didn't find target. Inspect screenshot: ${shotPath}. Likely cause: (1) game stuck in modal/loading từ run trước; (2) Buy Feature thật sự không có trên game này; (3) game vừa load chưa render xong UI.`,
          framesCaptured: 0,
          durationMs: Date.now() - t0,
        };
      }
      await page.mouse.move(decision.x, decision.y);
      await page.waitForTimeout(120);
      await page.mouse.click(decision.x, decision.y);
      await page.waitForTimeout(2_000);
    }

    // ===== Dismiss FS Award splash modal =====
    // PP games LUÔN show "YOU HAVE WON N FREE SPINS — PRESS ANYWHERE TO CONTINUE"
    // sau Buy confirm. Modal accept ANY click/key → brute-force dismiss deterministic,
    // KHÔNG cần LLM ($0 + reliable).
    //
    // Strategy stack (try mỗi cái, dừng khi network indicate FS chain progressed):
    //   1. Keyboard Space / Enter (luôn work nếu game listen keydown)
    //   2. Click viewport center (720, 450)
    //   3. Click multiple points (top/middle/bottom) — cover modal anti-hotspot
    //   4. LLM fallback nếu vẫn stuck (3 strategy trên fail)
    try {
      await page.waitForTimeout(3_000); // splash animation hiện sau ~2s
      console.log(`[capture-fs] Brute-force dismiss FS-award splash modal (deterministic)...`);

      const beforeFrameCount = capturedFrames.length;
      const stillStuck = () => capturedFrames.length === beforeFrameCount;

      // Strategy 1: Keyboard (cheap, no coord needed)
      try {
        await page.keyboard.press("Space");
        await page.waitForTimeout(1_500);
        if (!stillStuck()) console.log(`[capture-fs] ✓ Space key dismissed splash — chain progressing`);
      } catch {}

      // Strategy 2: Click viewport center
      if (stillStuck()) {
        await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2);
        console.log(`[capture-fs] click center (${VIEWPORT.width / 2},${VIEWPORT.height / 2})`);
        await page.waitForTimeout(2_500);
        if (!stillStuck()) console.log(`[capture-fs] ✓ center click dismissed splash — chain progressing`);
      }

      // Strategy 3: Multiple points (defensive — modal có thể có anti-center hotspot)
      if (stillStuck()) {
        const points: Array<[number, number]> = [
          [720, 300], // upper-center
          [720, 600], // lower-center
          [400, 450], // left-middle
          [1040, 450], // right-middle
        ];
        for (const [x, y] of points) {
          if (!stillStuck()) break;
          await page.mouse.click(x, y);
          console.log(`[capture-fs] click (${x},${y}) — defensive dismiss`);
          await page.waitForTimeout(1_500);
        }
      }

      // Strategy 4: LLM fallback nếu deterministic strategies đều fail
      if (stillStuck()) {
        console.warn(`[capture-fs] Deterministic dismiss failed — falling back to LLM`);
        const splashShot = await page.screenshot({ type: "png" });
        const splashDecision = await decideClick(
          splashShot.toString("base64"),
          "FS-award splash modal blocking game. Click the most likely spot to dismiss (modal center or 'PRESS ANYWHERE' label area).",
          VIEWPORT,
        );
        if (!splashDecision.done && splashDecision.x > 0 && splashDecision.y > 0) {
          await page.mouse.click(splashDecision.x, splashDecision.y);
          console.log(`[capture-fs] LLM-guided splash click @ (${splashDecision.x},${splashDecision.y})`);
          await page.waitForTimeout(2_500);
        }
      }

      if (stillStuck()) {
        console.warn(`[capture-fs] ⚠ FS-award splash MAY still be blocking — proceeding anyway. If timeout, check screenshot.`);
      }
    } catch (err) {
      console.warn(`[capture-fs] FS-award splash dismiss failed (non-fatal): ${(err as Error).message}`);
    }

    // ===== Wait for FS chain =====
    console.log(`[capture-fs] Buy clicked — waiting for FS chain (max ${timeoutMs / 1000}s, idle ${idleMs / 1000}s)...`);
    const startWait = Date.now();
    while (Date.now() - startWait < timeoutMs) {
      if (chainEnded) break;
      if (chainStarted) {
        // Smart end detection theo state của chain:
        //  - Đã reach fsmax (fs counter = total expected) → animation settlement
        //    cuối chỉ vài giây → dùng idle ngắn (idleMs).
        //  - Chưa reach fsmax + biết fsmax → game đang play các FS giữa chain →
        //    animation 6-15s/FS + intro splash đôi khi 30s → KHÔNG idle, đợi
        //    timeout safety net (180s) hoặc chain end normal.
        //  - Chưa biết fsmax (game không expose) → fallback idle dài (60s) để
        //    cover slowest cascade animation.
        const reachedMax = fsMaxObserved > 0 && fsCurrentMax >= fsMaxObserved;
        let effectiveIdle: number | null;
        if (reachedMax) effectiveIdle = idleMs;
        else if (fsMaxObserved > 0) effectiveIdle = null; // wait timeout
        else effectiveIdle = Math.max(idleMs * 4, 60_000);
        if (effectiveIdle != null && Date.now() - lastResponseAt > effectiveIdle) {
          console.log(
            `[capture-fs] idle ${(effectiveIdle / 1000).toFixed(0)}s (fs=${fsCurrentMax}/${fsMaxObserved || "?"}, reachedMax=${reachedMax}) → declaring end`,
          );
          chainEnded = true;
          break;
        }
      }
      await page.waitForTimeout(500);
    }
    if (chainStarted && fsMaxObserved > 0 && fsCurrentMax < fsMaxObserved) {
      console.warn(
        `[capture-fs] WARNING: chain cut sớm — captured ${fsCurrentMax}/${fsMaxObserved} FS frames. ` +
          `Animation chậm hơn idle threshold ${idleMs / 1000}s. ` +
          `Retry với --idle-ms 30000 hoặc fsChainIdleMs=30000 opt.`,
      );
    }

    if (capturedFrames.length === 0) {
      return {
        ok: false,
        reason: `no FS chain captured after buy — buy click có thể đã không trigger, hoặc game không support Buy Feature trên demo`,
        framesCaptured: 0,
        durationMs: Date.now() - t0,
      };
    }

    // ===== Dismiss win celebration modal — tránh state contamination =====
    // FS chain end để lại "CONGRATULATIONS YOU HAVE WON $X" modal (collect),
    // có thể 2-layer (collect → continue). Brute-force key+click reliable.
    try {
      console.log(`[capture-fs] Brute-force dismiss FS-end win celebration modal (cleanup)...`);
      await page.waitForTimeout(2_500); // let win-popup animation settle

      // 3 rounds of keyboard + center click (cover multi-layer modal)
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Space").catch(() => {});
        await page.waitForTimeout(800);
        await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2);
        await page.waitForTimeout(1_800);
      }

      // LLM verify state clean (1 call)
      const probeShot = await page.screenshot({ type: "png" });
      const probe = await decideClick(
        probeShot.toString("base64"),
        "Is the game UI back to base game (reels visible + spin button visible + no celebration modal)? Done=true if clean. Else click modal center to dismiss.",
        VIEWPORT,
      );
      if (probe.done) {
        console.log(`[capture-fs] ✓ game state clean — subsequent runs OK`);
      } else if (probe.x > 0 && probe.y > 0) {
        await page.mouse.click(probe.x, probe.y);
        console.log(`[capture-fs] LLM cleanup final click @ (${probe.x},${probe.y}) — ${probe.reason}`);
      }
    } catch (err) {
      console.warn(`[capture-fs] dismiss-win-modal step failed (non-fatal): ${(err as Error).message}`);
      console.warn(`[capture-fs] WARNING: game state có thể vẫn còn unclaimed win modal — subsequent test runs sẽ tốn LLM fallback. Khắc phục: chạy "Re-record Pre-game".`);
    }

    // ===== Build + save scenario =====
    const firstParsed = capturedFrames[0]!.parsed ?? {};
    const lastParsed = capturedFrames[capturedFrames.length - 1]!.parsed ?? {};
    const triggerBet = (() => {
      const explicit = Number(
        (firstParsed as any).betAmount ?? (firstParsed as any).bet ?? NaN,
      );
      if (Number.isFinite(explicit) && explicit > 0) return explicit;
      const c = Number((firstParsed as any).c ?? NaN);
      const l = Number((firstParsed as any).l ?? NaN);
      return Number.isFinite(c) && Number.isFinite(l) && c > 0 && l > 0 ? c * l : c || 0;
    })();
    const totalWin = Number((lastParsed as any).tw ?? 0) || 0;

    const sc: Scenario = {
      slug: opts.slug,
      label: "free_spin",
      description: `FS chain (${capturedFrames.length} frames) captured via Buy Feature on ${new Date().toISOString()}`,
      source_recording: `capture-fs-via-buy (${capturedFrames.length} frames)`,
      spin_response: capturedFrames[0]!,
      spin_sequence: capturedFrames,
      expected: {
        bet: triggerBet,
        win: totalWin,
        ending_balance:
          Number(
            (lastParsed as any).balance ?? (lastParsed as any).endingBalance ?? 0,
          ) || 0,
        has_bonus: true,
        is_free_spin: true,
      },
      frozen_time_ms: 1_735_689_600_000,
      random_seed: 42,
    };
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(sc, null, 2));
    console.log(
      `[capture-fs] ★ Saved chain (${capturedFrames.length} frames, totalWin=${totalWin.toFixed(2)}) → ${target}`,
    );

    return {
      ok: true,
      reason: `captured_${capturedFrames.length}_frames`,
      framesCaptured: capturedFrames.length,
      scenarioPath: target,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      ok: false,
      reason: (err as Error).message,
      framesCaptured: capturedFrames.length,
      durationMs: Date.now() - t0,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

// ===== CLI entry =====
function parseFlag(args: string[], name: string): string | undefined {
  // Support --name=value AND --name value forms
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const slug = args[0];
  if (!slug) {
    console.error("Usage: tsx src/runner/capture-fs-via-buy.ts <slug> [opts]");
    console.error("  Required: GAME_URL env var");
    console.error("  Optional flags:");
    console.error("    --overwrite              re-capture dù scenario đã tồn tại");
    console.error("    --headless               browser headless mode");
    console.error("    --timeout-ms <N>         max wait cho FS chain end (default 180000, vd 300000=5m)");
    console.error("    --idle-ms <N>            idle threshold sau khi reach fsmax (default 15000)");
    console.error("  Or env: QA_FS_CHAIN_TIMEOUT_MS, QA_FS_CHAIN_IDLE_MS");
    process.exit(1);
  }
  const gameUrl = process.env.GAME_URL;
  if (!gameUrl) {
    console.error("GAME_URL env var required.");
    process.exit(1);
  }
  // Precedence: CLI flag > env > default (inside captureFsViaBuy)
  const timeoutFlag = parseFlag(args, "timeout-ms");
  const idleFlag = parseFlag(args, "idle-ms");
  const timeoutMs = timeoutFlag
    ? Number(timeoutFlag)
    : process.env.QA_FS_CHAIN_TIMEOUT_MS
      ? Number(process.env.QA_FS_CHAIN_TIMEOUT_MS)
      : undefined;
  const idleMs = idleFlag
    ? Number(idleFlag)
    : process.env.QA_FS_CHAIN_IDLE_MS
      ? Number(process.env.QA_FS_CHAIN_IDLE_MS)
      : undefined;
  const result = await captureFsViaBuy({
    slug,
    gameUrl,
    overwrite: args.includes("--overwrite"),
    headless: args.includes("--headless"),
    fsChainTimeoutMs: timeoutMs,
    fsChainIdleMs: idleMs,
  });
  console.log("\nResult:", JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
