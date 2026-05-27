import type { Page } from "playwright";
import type { BaseParser } from "../step6-build-model/base-parser.js";
import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import type { UiRegistry } from "../registry/types.js";
import type { CaptureHandle } from "../step3-capture-network/types.js";
import { pairRequestsToResponses } from "../step3-capture-network/pair.js";
import { dismissOverlays } from "../step3-smoke/dismiss-overlays.js";
import {
  diffAroundAction,
  waitUntilStable,
  detectBlackScreen,
  type Region,
} from "../utils/pixel-diff/index.js";
import type { MassiveSpinOptions, MassiveSpinResult } from "./types.js";

const REELS_REGION_DEFAULT: Region = { x: 200, y: 150, width: 1400, height: 700 };
const SPIN_API_URL_RE = /\/(gameService|spin|doSpin|gs2c\/v3)/i;
const POST_CLICK_NETWORK_WINDOW_MS = 3000;

export type UiModeIssue = {
  spinIndex: number;
  kind: "spin_not_started" | "screen_not_stable" | "black_screen" | "no_spin_response";
  detail: string;
};

export type UiModeResult = MassiveSpinResult & { issues: UiModeIssue[] };

export async function runUiMode(
  page: Page,
  uiMap: UiRegistry,
  capture: CaptureHandle,
  parser: BaseParser,
  opts: MassiveSpinOptions,
): Promise<UiModeResult> {
  const start = Date.now();
  const spins: NormalizedSpinResult[] = [];
  const issues: UiModeIssue[] = [];
  const spin = uiMap.spinButton;
  if (!spin) throw new Error("spinButton missing in uiMap");

  // Pre-spin: dismiss any popup that might have appeared between discover-ui
  // and now (e.g. "you won X" celebration after smoke phase).
  await dismissOverlays(page, { initialWaitMs: 1500, perClickWaitMs: 800, finalSettleMs: 1000 });

  let attempted = 0;
  let succeeded = 0;
  const seenResponseKeys = new Set<string>();
  let consecutiveSilentSpins = 0;

  for (let i = 0; i < opts.count; i++) {
    attempted++;
    const clickAt = Date.now();

    const { changed, ratio } = await diffAroundAction(
      page,
      async () => {
        await page.mouse.click(spin.x, spin.y);
      },
      { region: REELS_REGION_DEFAULT, postDelayMs: 800, changeThreshold: 0.05 },
    );

    // Network-confirmed spin: wait up to N ms for an actual spin response.
    // More reliable than pixel diff when game has subtle animations.
    const spinFired = await waitForSpinResponse(
      capture,
      clickAt,
      POST_CLICK_NETWORK_WINDOW_MS,
    );

    if (!spinFired) {
      consecutiveSilentSpins++;
      issues.push({
        spinIndex: i,
        kind: changed ? "no_spin_response" : "spin_not_started",
        detail: `no spin API response within ${POST_CLICK_NETWORK_WINDOW_MS}ms; pixel diff ${ratio.toFixed(3)}`,
      });
      if (consecutiveSilentSpins >= 3) {
        // Game stuck → try clearing popups, give it another chance.
        await dismissOverlays(page, { initialWaitMs: 500, perClickWaitMs: 600, finalSettleMs: 800 });
        consecutiveSilentSpins = 0;
      }
      continue;
    }
    consecutiveSilentSpins = 0;

    const stable = await waitUntilStable(page, {
      region: REELS_REGION_DEFAULT,
      maxIterations: 25,
      consecutiveStable: 3,
    });
    if (!stable) {
      issues.push({ spinIndex: i, kind: "screen_not_stable", detail: "reels did not stabilize" });
    }

    const black = await detectBlackScreen(page, 0.95);
    if (black.black) {
      issues.push({
        spinIndex: i,
        kind: "black_screen",
        detail: `black ratio ${black.ratio.toFixed(3)} — possible crash`,
      });
    }

    const rounds = capture.flush();
    const pairs = pairRequestsToResponses(rounds);
    for (const pair of pairs) {
      const res = pair.response;
      if (!res.body) continue;
      const key = `${res.url}@${res.timing.startedAt}`;
      if (seenResponseKeys.has(key)) continue;
      if (!parser.canParseResponse(res.body, res.url)) {
        seenResponseKeys.add(key);
        continue;
      }
      try {
        const parsed = parser.parseSpinPair
          ? parser.parseSpinPair(pair.request?.body ?? null, res.body, res.url)
          : parser.parseResponse(res.body);
        (parsed.raw as Record<string, unknown>)["__winDisplayDiff"] = ratio;
        spins.push(parsed);
        succeeded++;
        seenResponseKeys.add(key);
      } catch {
        seenResponseKeys.add(key);
      }
    }
  }

  return {
    mode: "ui",
    attempted,
    succeeded,
    spins,
    durationMs: Date.now() - start,
    issues,
  };
}

async function waitForSpinResponse(
  capture: CaptureHandle,
  cutoffTimestamp: number,
  windowMs: number,
): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const rounds = capture.flush();
    for (const round of rounds) {
      for (const res of round.responses) {
        if (res.timing.startedAt < cutoffTimestamp) continue;
        if (!SPIN_API_URL_RE.test(res.url)) continue;
        const body = res.body ?? "";
        // PP doSpin responses have `na=s` (next action = spin) + reels data.
        if (body.includes("na=s") || /reel|"s"|s=[a-zA-Z0-9]/.test(body)) {
          return true;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
