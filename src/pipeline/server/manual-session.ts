// Manual verify session — long-lived Playwright browser kept open between
// dashboard interactions. QA opens game → backend launches headed Chrome →
// QA verifies each UI element via dashboard commands → registry saved.
//
// One session at a time (singleton). Concurrent sessions would race over the
// shared registry file; restrict to single-QA for MVP.

import path from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { openBrowser, closeBrowser, type BrowserSession } from "../orchestrator/browser.js";
import { crawl } from "../step1-crawl/crawler.js";
import { discoverUi } from "../step2-detect-ui/resolver.js";
import { resolveExpectedUiElements } from "../registry/expected-ui-elements.js";
import { aiRecoverLocator } from "../step2-detect-ui/ai-recover-locator.js";
import { aiDiscoverState } from "../step2-detect-ui/graph-explorer.js";
import { verifyElement, ELEMENT_VISUAL_CHECK } from "../step2-detect-ui/ai-vision-verify.js";
import { loadAiCatalog } from "../step7-testcase-gen/ai-catalog.js";
import {
  loadCache as loadActionsCache,
  saveCache as saveActionsCache,
  translateCase,
} from "../step7-testcase-gen/case-action-translator.js";
import { executeCase, type CaseResult } from "../step8-run-scenarios/case-executor.js";
import "../step6-build-model/index.js";
import { createParserForGame } from "../step6-build-model/parser-factory.js";
import { parserCache } from "../registry/parser-cache.js";
import { uiRegistry } from "../registry/ui-registry.js";
import { initMeta, meta } from "../registry/meta.js";
import { providerCache } from "../registry/provider-cache.js";
import { gameMechanics, deriveGameMechanics } from "../registry/game-mechanics.js";
import { payoutModel } from "../registry/payout-model.js";
import { paytable as paytableStore } from "../registry/paytable.js";
import { parseWlcV } from "../step6-build-model/win-breakdown.js";
import { derivePayoutModel, type CalibrationCombo } from "../../ai/payout-model-derive.js";
import { probeElement, inferProbeKind, type ProbeResult } from "../step2-detect-ui/element-probe.js";
import { verifyClickAgent } from "../../ai/verify-click-agent.js";
import { expectedBehaviorFor } from "../registry/expected-behavior.js";
import { exploreUiGraph, explainSafety } from "../step2-detect-ui/graph-explorer.js";
import { isSafeToClickForDiscovery } from "../step2-detect-ui/safe-click.js";
import { filterMainOverlap, buildMainElementsHint } from "../step2-detect-ui/popup-filter.js";
import { waitUntilStable } from "../utils/pixel-diff/index.js";
import { cropVerifyAgent, type AgentLocateResult } from "../../ai/crop-verify-agent.js";
import { describeCanonicalElement, enrichDescriptionWithSpinAnchor } from "../registry/canonical-element-hints.js";
import { detectCanonicalCluster, discoverCanonicalPerElement } from "../step2-detect-ui/discover-canonical-per-element.js";
import { saveDiscoverySnapshot } from "../registry/discovery-snapshots.js";
import { pragmaticProvider } from "../../adapters/providers/pragmatic.js";
import { dirForGame } from "../registry/paths.js";
import { diffVsBaseline, regionAround } from "../utils/pixel-diff/index.js";
import { dismissPopupsLoop, detectAnyPopup, detectDarkOverlay, isFreeSpinChainActive, SUBSTATE_POPUP_KEYWORDS } from "../utils/ocr-popup.js";
import { resolvePopupKeywords } from "../registry/popup-keywords.js";
import { resolveSubStateHints, SUB_STATE_HINTS_DEFAULTS, interpolateSliderStops, type SubStateHint } from "../registry/sub-state-hints.js";
import { readFile } from "node:fs/promises";
import type { UiRegistry, UiElement } from "../registry/types.js";

export type SessionStatus = {
  active: boolean;
  gameSlug: string | null;
  gameUrl: string | null;
  startedAt: string | null;
  registry: UiRegistry | null;
  verifyState: Record<string, "pending" | "confirmed" | "rejected">;
  subStateSuggestions: SubStateSuggestion[];
  /** P4 — main-state element keys discovery targets (defaults + per-game).
   *  Dashboard diffs this against registry keys to show a "missing" checklist. */
  expectedElements: string[];
  /** P3 — game-specific buttons auto-added to the registry beyond the expected
   *  list. Dashboard highlights these as AI-discovered extras to verify. */
  discoveryAutoAdded: Array<{ key: string; x: number; y: number; confidence: number; note?: string }>;
  /** True while an auto-onboard run is executing in the background. Dashboard
   *  uses this to restore the "Onboarding…" disabled-button state after a
   *  page reload — without it the button re-enables and QA assumes the run
   *  stopped, even though the server-side job is still running. */
  autoOnboardInProgress: boolean;
};

export type SubStateSuggestion = {
  /** Main-state uiKey to click to open this sub-screen. */
  triggerKey: string;
  /** Namespace label to use when storing discovered sub-state elements. */
  stateLabel: string;
  /** Human-readable name shown on dashboard. */
  description: string;
  /** Already discovered (state-label-prefixed entries exist) → don't re-suggest. */
  alreadyDiscovered: boolean;
};

/**
 * Optional friendly labels/descriptions for known main-state buttons. Used
 * only to make suggestions more readable; ALL main-state buttons are
 * suggested for sub-state discovery — clicking spinButton/betPlus/betMinus
 * may also reveal new state (spin-in-progress controls, bet-multiplier
 * popup, etc.). Keys not in this map fall back to autogenerated label.
 */
// Sub-state hints moved to src/pipeline/registry/sub-state-hints.ts (Phase
// 7.1G). Imported as SUB_STATE_HINTS_DEFAULTS — `computeSuggestions` below
// uses defaults; runtime sub-state discovery (manualSession) resolves per
// game via resolveSubStateHints().
const SUB_STATE_HINTS: Record<string, SubStateHint> = SUB_STATE_HINTS_DEFAULTS;

/**
 * Reverse of the SUB_STATE_HINTS stateLabel mapping. Used to migrate
 * legacy registry keys (saved when discover used the stateLabel as namespace
 * prefix, e.g. "autoplay_popup__turboSpinToggle") into the canonical
 * path-style format ("autoButton__turboSpinToggle"). Run once at session
 * start so AI translator + tree display + executor all see consistent keys.
 */
const LEGACY_NAMESPACE_TO_TRIGGER: Record<string, string> = {
  autoplay_popup: "autoButton",
  bet_minus_state: "betMinus",
  bet_plus_state: "betPlus",
  buy_feature_popup: "buyBonusButton",
  menu: "menuButton",
  paytable: "paytableButton",
  history_popup: "historyButton",
  settings: "settingsButton",
  spin_in_progress: "spinButton",
  turbo_state: "turboButton",
};

/**
 * Rename keys with legacy namespace prefixes to canonical trigger-name form.
 * Mutates registry in-place. Returns list of renames performed (for logging).
 * Collisions (canonical key already exists) are skipped — keeps existing.
 */
function migrateLegacyNamespaces(
  registry: UiRegistry,
): Array<{ old: string; new: string; skipped?: boolean }> {
  const renames: Array<{ old: string; new: string; skipped?: boolean }> = [];
  const oldKeys = Object.keys(registry);
  for (const oldKey of oldKeys) {
    const firstDelim = oldKey.indexOf("__");
    if (firstDelim === -1) continue;
    const topNs = oldKey.slice(0, firstDelim);
    const trigger = LEGACY_NAMESPACE_TO_TRIGGER[topNs];
    if (!trigger) continue;
    const newKey = trigger + oldKey.slice(firstDelim);
    if (registry[newKey]) {
      renames.push({ old: oldKey, new: newKey, skipped: true });
      continue;
    }
    (registry as Record<string, UiElement | undefined>)[newKey] = registry[oldKey];
    delete (registry as Record<string, UiElement | undefined>)[oldKey];
    renames.push({ old: oldKey, new: newKey });
  }
  return renames;
}

/**
 * Stricter prompt used for popup/sub-state discovery. Tells AI to ONLY return
 * elements inside the just-opened overlay, ignoring main-game controls in the
 * background. Coord-overlap dedup in discoverSubState is the safety net for
 * cases where AI still includes background buttons.
 */
const POPUP_FOCUS_PROMPT = `A popup, modal, or sub-screen has just opened on top of the main slot-game UI. The popup is typically:
- Centered (or large overlay) on screen
- Has a darker / dimmed background OUTSIDE its bounds
- Contains buttons specific to its function (Buy options, Settings tabs, Paytable info, History rows, etc.)

Identify ONLY the clickable elements INSIDE this popup/overlay. DO NOT include:
- Main-game buttons visible BEHIND or AROUND the popup (e.g. the spin/bet controls in the background)
- Decorative panels or text labels — only actually-clickable buttons/icons/toggles

SLIDERS / PRESET SELECTORS (IMPORTANT):
If the popup contains a slider, a track of numeric preset chips, or a row of selectable values (e.g. an autoplay popup showing "10  20  25  50  75  100"), emit ONE element PER discrete value, using the EXACT visible number in the key:
- Slider name should describe what the slider controls (autospins, betLevel, coinValue, etc.)
- Key pattern: <sliderName>-<value> using kebab-case (e.g. "autospins-10", "autospins-20", "autospins-25", "autospins-50", "autospins-75", "autospins-100")
- Coordinates point at the CENTER of each tick / label / chip — clicking that exact spot must select that value
- Read the label numbers carefully from the screenshot; do NOT invent values that aren't visible
- If the slider only shows a track without numeric labels (continuous slider), instead emit a single handle element with key "<sliderName>-handle"

Other popup buttons (start, stop, close, tabs) should still be emitted as normal semantic keys alongside the slider presets.

If you genuinely cannot identify a popup overlay (e.g. clicking the button just triggered an inline action with no new screen), return an empty elements array.

Return JSON in this shape:
{
  "stateLabel": "<short_kebab_case_label_for_this_popup>",
  "elements": [
    { "key": "kebab-case-key", "x": int, "y": int, "confidence": 0..1, "role": "close|tab|action|toggle|nav|slider-preset|other" }
  ]
}

Rules:
- Use semantic keys describing the popup's role: closeButton, freeSpinsTab, buyMaxButton, prevPageButton, soundToggle, etc.
- For slider presets use role "slider-preset" and the <sliderName>-<value> key pattern described above.
- Coordinates are CSS pixels from top-left of the FULL viewport screenshot.
- confidence 0..1.

JSON only, no prose.`;

function humanizeKey(key: string): string {
  // camelCase → "camel Case"
  return key.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function computeSuggestions(registry: UiRegistry | null): SubStateSuggestion[] {
  if (!registry) return [];
  const keys = Object.keys(registry);
  const out: SubStateSuggestion[] = [];
  for (const triggerKey of keys) {
    if (triggerKey.includes("__")) continue; // skip already-namespaced sub-state keys
    const hint = SUB_STATE_HINTS[triggerKey];
    // State label = triggerKey itself (path-style nesting). Children saved as
    // <triggerKey>__<childKey>. Consistent with per-row [Discover] button.
    const stateLabel = triggerKey;
    const description = hint?.description ?? `State after clicking ${humanizeKey(triggerKey)}`;
    const prefix = `${stateLabel}__`;
    const alreadyDiscovered = keys.some((k) => k.startsWith(prefix));
    out.push({ triggerKey, stateLabel, description, alreadyDiscovered });
  }
  return out;
}

/** Snap a proposed bbox into the page viewport so `page.screenshot({clip})`
 *  never throws ClipOutOfBounds. Used by the AI ocr-region detector when
 *  the model returns a slightly-overshooting bbox (rounding, near-edge). */
function clampBboxForViewport(
  bbox: { x: number; y: number; width: number; height: number },
  vp: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.min(vp.width - 1, Math.round(bbox.x)));
  const y = Math.max(0, Math.min(vp.height - 1, Math.round(bbox.y)));
  const w = Math.max(1, Math.min(vp.width - x, Math.round(bbox.width)));
  const h = Math.max(1, Math.min(vp.height - y, Math.round(bbox.height)));
  return { x, y, width: w, height: h };
}

/** Crop a PNG buffer in memory. Used to extract verify-crops from a
 *  baseline screenshot WITHOUT touching the live Playwright page —
 *  important when autoDetectOcrRegions runs in parallel with deepDiscover
 *  (which is busy opening popups; a concurrent page.screenshot would
 *  capture mid-popup state and break crop verification). */
function cropPngBufferSync(
  buf: Buffer,
  clip: { x: number; y: number; width: number; height: number },
): Buffer {
  const { PNG } = require("pngjs") as typeof import("pngjs");
  const src = PNG.sync.read(buf);
  const sx = Math.max(0, Math.min(src.width, Math.round(clip.x)));
  const sy = Math.max(0, Math.min(src.height, Math.round(clip.y)));
  const sw = Math.max(1, Math.min(src.width - sx, Math.round(clip.width)));
  const sh = Math.max(1, Math.min(src.height - sy, Math.round(clip.height)));
  const dst = new PNG({ width: sw, height: sh });
  for (let y = 0; y < sh; y++) {
    const srcRow = ((sy + y) * src.width + sx) * 4;
    const dstRow = y * sw * 4;
    src.data.copy(dst.data, dstRow, srcRow, srcRow + sw * 4);
  }
  return PNG.sync.write(dst);
}

export class ManualSessionManager {
  private session: BrowserSession | null = null;
  private gameSlug: string | null = null;
  private gameUrl: string | null = null;
  private startedAt: string | null = null;
  private registry: UiRegistry | null = null;
  private verifyState: Record<string, "pending" | "confirmed" | "rejected"> = {};
  /** 2026-06-01: mutex for expensive long-running ops (autoOnboard,
   *  deepDiscover). Node's single-threaded event loop happily queues
   *  multiple concurrent HTTP requests against the same route; without this
   *  guard, a curl that was TaskStop'd CLIENT-SIDE still has its request
   *  sitting in the server queue, ready to fire after the current one
   *  completes. Observed: 4 prior curl tasks stacked up → server ran
   *  autoOnboard 5 times in a row, last 4 overwriting the first's results.
   *  Set when work begins, cleared in finally. Re-entries return 409. */
  private autoOnboardInProgress = false;
  /** P3 — game-specific buttons the AI noticed beyond the expected list during
   *  the last discovery, AUTO-ADDED to the registry as pending. Tracked so the
   *  dashboard can highlight them for QA to verify / rename / remove. */
  private discoveryAutoAdded: Array<{ key: string; x: number; y: number; confidence: number; note?: string }> = [];
  /** P4 — resolved expected-element target keys for the active game (defaults
   *  + per-game overrides). Populated on start/resume; read by status() to feed
   *  the dashboard "missing elements" checklist. */
  private expectedElementKeys: string[] = [];
  /**
   * Wallet balance tracker. Updated from any network response containing
   * `balance=N` (doInit, doSpin, reloadBalance, etc.). Used as priorBalance
   * for case-executor — so first spin's startingBalance isn't null even
   * when the spin response itself doesn't expose startingBalance.
   *
   * Lifecycle: reset on session start/resume/stop. Listener attached once
   * per page; persists across reloads (browser context survives reload).
   */
  private lastBalance: number | null = null;

  /**
   * Game spec extracted from doInit response — used by case-action-translator
   * to generate correct actions (ladder-aware bet adjustment, multi-spin, etc.).
   * Captured automatically from network listener; null until doInit observed.
   */
  private gameSpec: {
    coinValues: number[];     // sc=0.01,0.015,...
    lines: number;            // l=20
    defaultCoin: number;      // defc=0.15
    betLevels: number[];      // bls=20,100,200
    betMin: number;           // total_bet_min=0.2
    betMax: number;           // total_bet_max=10000
    defaultBet: number;       // computed: defc * l
    betLadder: number[];      // computed: coinValues.map(c => c * l)
  } | null = null;

  /**
   * Game mechanic cache loaded from registry on resume(), or derived from
   * first observed balance-changing spin in start(). `undefined` = not yet
   * loaded; `null` = no entry exists; object = available. Avoids repeated
   * disk reads + repeated derivation attempts.
   */
  private gameMechanicsCached: import("../registry/types.js").GameMechanics | null | undefined = undefined;

  async start(url: string, opts: { autoDiscover?: boolean } = {}): Promise<SessionStatus> {
    if (this.session) {
      throw new Error("Session already active — call stop() first");
    }
    // Headed by default so QA can watch what the backend is doing. Override
    // with QA_HEADLESS=1 for CI / remote deploys / batch onboard without UI.
    this.session = await openBrowser(process.env.QA_HEADLESS === "1");
    this.gameUrl = url;
    this.startedAt = new Date().toISOString();
    this.lastBalance = null;
    this.attachBalanceTracker();

    const crawled = await crawl(this.session.page, { gameUrl: url });
    this.gameSlug = crawled.gameSlug;
    this.expectedElementKeys = (await resolveExpectedUiElements(this.gameSlug)).map((e) => e.key);
    await initMeta(this.gameSlug, url);
    await providerCache.save(this.gameSlug, {
      provider: crawled.provider,
      gameName: crawled.gameName,
      platform: crawled.platform,
      iframeCount: crawled.iframeCount,
      canvasCount: crawled.canvasCount,
      detectedAt: new Date().toISOString(),
    });

    // OCR popup dismissal — detect "PRESS ANYWHERE TO CONTINUE" etc. and
    // auto-click to clear before UI discovery. Deterministic (Tesseract.js,
    // no AI). Skips if no popup keywords detected.
    try {
      await this.session.page.waitForTimeout(2000); // let popup render
      const r = await dismissPopupsLoop(this.session.page);
      if (r.attempts > 0) console.log(`[manual/ocr] popup dismiss: ok=${r.ok} attempts=${r.attempts} matched=${r.finalDetect.matchedKeywords.join(",")}`);
    } catch (err) {
      console.warn(`[manual/ocr] popup dismiss failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    // Server-side account state may carry an active autoplay from a previous
    // browser session. Detect spontaneous spin responses + stop before discover
    // runs (otherwise discover sees a moving game + AI vision drifts).
    try {
      const a = await this.stopAutoplayIfActive();
      if (a.wasActive) console.log(`[manual/autoplay-stop] stopped leaked autoplay on start`);
    } catch (err) {
      console.warn(`[manual/autoplay-stop] failed on start (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    if (opts.autoDiscover !== false) {
      // Run initial AI discovery so QA has a seed registry to verify.
      // QA can confirm/reject/edit each entry.
      //
      // IMPORTANT: disable AI verify-loop here. In manual mode, the HUMAN is
      // the verifier — AI auto-verify (3 rounds per element) is redundant and
      // adds 30-60s of latency before dashboard becomes interactive. Restore
      // prior env state in finally to avoid leaking globally.
      const prevVerify = process.env.QA_UI_VERIFY_LOOP;
      process.env.QA_UI_VERIFY_LOOP = "0";
      try {
        const { uiMap, autoAdded } = await discoverUi(this.session.page, { slug: this.gameSlug });
        this.registry = uiMap;
        this.discoveryAutoAdded = autoAdded ?? [];
        for (const key of Object.keys(uiMap)) this.verifyState[key] = "pending";
        if (this.discoveryAutoAdded.length > 0) {
          console.log(`[manual] auto-added ${this.discoveryAutoAdded.length} extra button(s): ${this.discoveryAutoAdded.map((a) => a.key).join(", ")}`);
        }
        await uiRegistry.save(this.gameSlug, uiMap);
      } finally {
        if (prevVerify === undefined) delete process.env.QA_UI_VERIFY_LOOP;
        else process.env.QA_UI_VERIFY_LOOP = prevVerify;
      }
    } else {
      // Pure manual mode: empty registry, QA builds it from scratch.
      this.registry = {};
    }

    return this.status();
  }

  status(): SessionStatus {
    return {
      active: this.session !== null,
      gameSlug: this.gameSlug,
      gameUrl: this.gameUrl,
      startedAt: this.startedAt,
      registry: this.registry,
      verifyState: { ...this.verifyState },
      subStateSuggestions: computeSuggestions(this.registry),
      expectedElements: [...this.expectedElementKeys],
      discoveryAutoAdded: [...this.discoveryAutoAdded],
      autoOnboardInProgress: this.autoOnboardInProgress,
    };
  }

  /** Click at the cached coord of a registered element. QA watches result. */
  async clickElement(uiKey: string): Promise<{ ok: boolean; clickedAt: { x: number; y: number } | null; error?: string }> {
    if (!this.session || !this.registry) return { ok: false, clickedAt: null, error: "no active session" };
    const el = this.registry[uiKey];
    if (!el) return { ok: false, clickedAt: null, error: `uiKey ${uiKey} not in registry` };
    try {
      await this.session.page.mouse.click(el.x, el.y);
      return { ok: true, clickedAt: { x: el.x, y: el.y } };
    } catch (err) {
      return { ok: false, clickedAt: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Click at arbitrary coord (manual correction). */
  async clickAt(x: number, y: number): Promise<{ ok: boolean; error?: string }> {
    if (!this.session) return { ok: false, error: "no active session" };
    try {
      await this.session.page.mouse.click(x, y);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Confirm (verify) an element — marks status verified + verifiedBy QA. */
  async confirm(uiKey: string): Promise<void> {
    if (!this.session || !this.gameSlug || !this.registry) throw new Error("no active session");
    const el = this.registry[uiKey];
    if (!el) throw new Error(`uiKey ${uiKey} not in registry`);
    el.verifiedBy = "QA";
    el.status = "verified";
    el.verifiedAt = new Date().toISOString();
    this.verifyState[uiKey] = "confirmed";
    await uiRegistry.save(this.gameSlug, this.registry);
  }

  /**
   * Bulk verify ALL descendants of a parent element (keys starting with
   * `<parentKey>__`, including grandchildren). The parent itself is NOT
   * touched. Use to verify a whole popup's children in one click (e.g. all
   * autoCountSlide-N slider stops under autoButton).
   */
  async confirmChildren(parentKey: string): Promise<{ ok: boolean; count: number; reason?: string }> {
    if (!this.session || !this.gameSlug || !this.registry) return { ok: false, count: 0, reason: "no active session" };
    const prefix = `${parentKey}__`;
    const childKeys = Object.keys(this.registry).filter((k) => k.startsWith(prefix) && this.registry[k]);
    if (childKeys.length === 0) return { ok: false, count: 0, reason: `no children under ${parentKey}` };
    const now = new Date().toISOString();
    for (const k of childKeys) {
      const el = this.registry[k]!;
      el.verifiedBy = "QA";
      el.status = "verified";
      el.verifiedAt = now;
      this.verifyState[k] = "confirmed";
    }
    await uiRegistry.save(this.gameSlug, this.registry);
    console.log(`[manual] bulk verified ${childKeys.length} children of ${parentKey}`);
    return { ok: true, count: childKeys.length };
  }

  /** QA manually corrects coord by clicking on dashboard screenshot. */
  async updateCoord(uiKey: string, x: number, y: number): Promise<void> {
    if (!this.session || !this.gameSlug || !this.registry) throw new Error("no active session");
    const existing = this.registry[uiKey];
    const now = new Date().toISOString();
    const updated: UiElement = {
      x: Math.round(x),
      y: Math.round(y),
      strategy: "manual",
      confidence: 1.0,
      detectedAt: now,
      baselineScreenshot: existing?.baselineScreenshot,
      verifiedBy: "QA",
      status: "verified",
      verifiedAt: now,
    };
    this.registry[uiKey] = updated;
    this.verifyState[uiKey] = "confirmed";
    await uiRegistry.save(this.gameSlug, this.registry);
  }

  /** Add a brand-new element (not in current registry). Rejects if key exists. */
  async addElement(uiKey: string, x: number, y: number): Promise<void> {
    if (!this.session || !this.gameSlug || !this.registry) throw new Error("no active session");
    if (this.registry[uiKey]) throw new Error(`uiKey '${uiKey}' already exists — use Pick in Game on its row to update, or Remove first`);
    const now = new Date().toISOString();
    const el: UiElement = {
      x: Math.round(x),
      y: Math.round(y),
      strategy: "manual",
      confidence: 1.0,
      detectedAt: now,
      verifiedBy: "QA",
      status: "verified",
      verifiedAt: now,
    };
    this.registry[uiKey] = el;
    this.verifyState[uiKey] = "confirmed";
    await uiRegistry.save(this.gameSlug, this.registry);
  }

  /**
   * Multi-level discovery with ANCESTOR PATH WALK + AUTO-RESET to main state.
   *
   * For nested triggers like "buyBonusButton__freeSpinsOption":
   *   1. Close any open popups (ESC ×2 + outside-click) → ensure main state
   *   2. Walk ancestor chain: click buyBonusButton, wait, click freeSpinsOption, wait
   *   3. AI-discover elements in resulting state → save under <triggerKey>__*
   *
   * Works regardless of starting state because step 1 force-resets to main.
   */
  async discoverVia(triggerKey: string, stateLabel: string): Promise<{ ok: boolean; addedKeys?: string[]; reason?: string; clickedPath?: Array<{ key: string; x: number; y: number }> }> {
    if (!this.session || !this.gameSlug || !this.registry) return { ok: false, reason: "no active session" };

    // 1. Reset to main state. Send ESC twice to close any nested popups, then
    //    click an empty corner to dismiss any non-ESC-respecting overlay. Slot
    //    games typically close popups via either ESC or background-click.
    const vp = this.session.page.viewportSize() ?? { width: 1280, height: 720 };
    try {
      await this.session.page.keyboard.press("Escape");
      await this.session.page.waitForTimeout(300);
      await this.session.page.keyboard.press("Escape");
      await this.session.page.waitForTimeout(300);
      // Click top-left corner (empty area, no game UI normally there) as
      // additional outside-click dismissal. Safe coord.
      await this.session.page.mouse.click(5, 5);
      await this.session.page.waitForTimeout(500);
    } catch {
      // Reset failures non-fatal — proceed with walk anyway.
    }
    void vp;

    // 2. Build ancestor chain: "a__b__c" → ["a", "a__b", "a__b__c"]
    const parts = triggerKey.split("__");
    const ancestors: string[] = [];
    for (let i = 1; i <= parts.length; i++) ancestors.push(parts.slice(0, i).join("__"));

    const clickedPath: Array<{ key: string; x: number; y: number }> = [];
    for (const key of ancestors) {
      const el = this.registry[key];
      if (!el) {
        return { ok: false, reason: `ancestor missing in registry: ${key} (need to discover + verify it first)`, clickedPath };
      }
      try {
        await this.session.page.mouse.click(el.x, el.y);
        clickedPath.push({ key, x: el.x, y: el.y });
      } catch (err) {
        return { ok: false, reason: `click on ${key} (${el.x},${el.y}) failed: ${err instanceof Error ? err.message : String(err)}`, clickedPath };
      }
      // Wait for popup to animate in + settle before next click or discovery.
      await this.session.page.waitForTimeout(1500);
    }

    // 3. AI-discover elements at the final state.
    const discovered = await this.discoverSubState(stateLabel);
    return { ...discovered, clickedPath };
  }

  /**
   * Multi-level discovery — after QA opens a popup/sub-screen (e.g. clicks
   * buyBonusButton → popup appears), QA invokes this with a state label.
   * AI vision detects clickable elements with popup-focus prompt:
   *   - Strict instruction to return ONLY popup/overlay elements
   *   - Filter out any element whose coord overlaps a known main-state entry
   *     (within 30px) — AI sometimes still sees main controls faintly through
   *     dimmed background
   */
  async discoverSubState(stateLabel: string): Promise<{ ok: boolean; addedKeys?: string[]; reason?: string }> {
    if (!this.session || !this.gameSlug || !this.registry) return { ok: false, reason: "no active session" };
    const safeLabel = stateLabel.trim().replace(/[^a-zA-Z0-9_]+/g, "_");
    if (!safeLabel) return { ok: false, reason: "stateLabel required (alphanumeric)" };
    const debugDir = path.join(dirForGame(this.gameSlug), "debug-subdiscover");
    await mkdir(debugDir, { recursive: true });
    try {
      // Per-popup discover hint: pin naming conventions / expected children for
      // known states (e.g. autoplay → autoCountSlide-N). The discover flow uses
      // the TRIGGER KEY as the stateLabel/namespace (e.g. "autoButton"), so the
      // hints map (keyed by trigger key) is looked up directly. Fall back to
      // matching by hint.stateLabel for ad-hoc / legacy labels.
      const hints = await resolveSubStateHints(this.gameSlug);
      const matched = hints[safeLabel] ?? Object.values(hints).find((h) => h.stateLabel === safeLabel);
      // Build the popup-discovery prompt with 3 layers:
      //   1. POPUP_FOCUS_PROMPT — general "this is a popup, ignore background".
      //   2. State-specific discoverHint (e.g. autoplay slider anchor instructions).
      //   3. Main-elements hint — explicit list of canonical main coords so AI
      //      knows EXACTLY which buttons are background bleed-through and must
      //      be skipped (matches the coord-based filter that runs post-AI).
      const stateGuidance = matched?.discoverHint
        ? `\n\n--- STATE-SPECIFIC GUIDANCE (${safeLabel}) ---\n${matched.discoverHint}`
        : "";
      const mainHint = buildMainElementsHint(this.registry);
      const prompt = `${POPUP_FOCUS_PROMPT}${stateGuidance}${mainHint}`;
      if (matched?.discoverHint) {
        console.log(`[manual/discover] applied discover-hint for "${safeLabel}" (${matched.discoverHint.length} chars)`);
      }
      const result = await aiDiscoverState(this.session.page, debugDir, Date.now(), prompt);
      if (result.elements.length === 0) {
        return { ok: false, reason: "AI returned 0 elements — popup may not be visible" };
      }

      // Drop main-screen false positives — AI sometimes flags main controls
      // visible THROUGH the dimmed popup background. Deterministic safety net
      // on top of the prompt's "DO NOT include main-game buttons behind the
      // popup" instruction (which AI doesn't always honor).
      const filtered = filterMainOverlap(result.elements, this.registry);
      if (filtered.dropped.length > 0) {
        const sample = filtered.dropped.slice(0, 5).map((d) => `${d.key}@(${d.x},${d.y})→${d.overlapsMainKey}`).join("; ");
        console.log(`[manual/discover] dropped ${filtered.dropped.length}/${result.elements.length} main-overlap false positives: ${sample}${filtered.dropped.length > 5 ? "…" : ""}`);
      }
      if (filtered.kept.length === 0) {
        return { ok: false, reason: `AI returned ${result.elements.length} elements but ALL overlapped main-screen controls — popup likely not open or fully transparent. Re-open the popup and retry.` };
      }
      // Use the FILTERED list from here on (snapshot + registry).
      const aiElements = filtered.kept;

      // Persist the AI's view of this state for visual QA review. Save with
      // NAMESPACED keys (matching the registry) so the dashboard can cross-ref
      // each marker against current verify status by key. Non-fatal on error.
      try {
        await saveDiscoverySnapshot(
          this.gameSlug,
          safeLabel,
          result.pngBuf,
          aiElements.map((e) => ({
            key: `${safeLabel}__${e.key}`,
            x: e.x,
            y: e.y,
            confidence: e.confidence,
            role: e.role,
          })),
          "discover-substate",
        );
      } catch (err) {
        console.warn(`[manual/snapshot] failed to save discovery snapshot for ${safeLabel}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // No dedup — QA wants every AI-returned element registered, even if
      // the coord overlaps an existing entry (e.g., betMinus and betPlus open
      // the SAME panel → same physical chips under different parent namespaces;
      // both names are legitimate keys the AI translator may reference).
      // Same-key under same parent will overwrite (idempotent re-discover).
      const addedKeys: string[] = [];
      const overwrittenKeys: string[] = [];
      const now = new Date().toISOString();
      for (const e of aiElements) {
        const namespacedKey = `${safeLabel}__${e.key}`;
        const wasPresent = Boolean(this.registry[namespacedKey]);
        const el: UiElement = {
          x: Math.round(e.x),
          y: Math.round(e.y),
          strategy: "ai_vision",
          confidence: e.confidence ?? 0.8,
          detectedAt: now,
          status: "pending",
        };
        this.registry[namespacedKey] = el;
        this.verifyState[namespacedKey] = "pending";
        if (wasPresent) overwrittenKeys.push(namespacedKey);
        else addedKeys.push(namespacedKey);
      }
      if (overwrittenKeys.length > 0) {
        console.log(`[manual/discover] overwrote ${overwrittenKeys.length} existing entries with fresh coords: ${overwrittenKeys.slice(0, 5).join(", ")}`);
      }

      // Continuous-slider stop synthesis: if this state has sliderMarks config
      // and the AI returned both track-end anchors, interpolate the discrete
      // stops EVENLY between them. Coords are ESTIMATED (low confidence) — QA
      // re-picks for precision. Anchors are then removed (the marks replace them).
      const sm = matched?.sliderMarks;
      if (sm) {
        const minEl = this.registry[`${safeLabel}__${sm.minAnchor}`];
        const maxEl = this.registry[`${safeLabel}__${sm.maxAnchor}`];
        if (minEl && maxEl && sm.values.length > 0) {
          const n = sm.values.length;
          const stops = interpolateSliderStops(minEl, maxEl, sm.values);
          for (const stop of stops) {
            const key = `${safeLabel}__${sm.keyPrefix}-${stop.value}`;
            const wasPresent = Boolean(this.registry[key]);
            this.registry[key] = {
              x: stop.x,
              y: stop.y,
              strategy: "ai_vision",
              confidence: 0.4, // estimated — QA must re-pick
              detectedAt: now,
              status: "pending",
            };
            this.verifyState[key] = "pending";
            if (!wasPresent) addedKeys.push(key);
          }
          // Remove the raw anchors — the synthesized marks supersede them.
          delete this.registry[`${safeLabel}__${sm.minAnchor}`];
          delete this.registry[`${safeLabel}__${sm.maxAnchor}`];
          delete this.verifyState[`${safeLabel}__${sm.minAnchor}`];
          delete this.verifyState[`${safeLabel}__${sm.maxAnchor}`];
          console.log(`[manual/discover] synthesized ${n} slider stops ${sm.keyPrefix}-{${sm.values.join(",")}} between anchors (estimated — QA re-pick) for ${safeLabel}`);
        } else {
          console.log(`[manual/discover] sliderMarks configured for ${safeLabel} but anchors not found (min=${!!minEl} max=${!!maxEl}) — skipped synthesis`);
        }
      }
      console.log(`[manual/discover] ${addedKeys.length} new + ${overwrittenKeys.length} overwritten under ${safeLabel}__*`);
      await uiRegistry.save(this.gameSlug, this.registry);
      // Auto-probe newly-added probeable elements (P1 of "AI auto-discover").
      // Discover happens at the sub-state we just entered; only canonical
      // main-screen-style keys (spinButton, betPlus, etc.) probe meaningfully
      // here — sub-state-scoped keys typically aren't probeable in P1.
      const probeable = addedKeys.filter((k) => inferProbeKind(k) != null);
      let probe: Awaited<ReturnType<typeof this.probePendingElements>> | undefined;
      if (probeable.length > 0) {
        probe = await this.probePendingElements({ onlyKeys: probeable });
      }
      return { ok: true, addedKeys, ...(probe ? { probe } : {}) };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * P1 of AI auto-discover — runtime self-validation gate. For each element
   * with status="pending" that has a probe defined (inferProbeKind), click the
   * proposed coord and observe a signal (network response / popup keyword).
   * On success: flip to verified + verifiedBy="probe" + record the signal tag.
   * On failure: stay pending for QA. Probes use offset retry (±5/10px) to
   * absorb AI-vision coord drift. Each probe leaves the game on MAIN.
   */
  async probePendingElements(
    opts: { onlyKeys?: string[] } = {},
  ): Promise<{
    ok: boolean;
    reason?: string;
    probed: number;
    verified: number;
    failed: number;
    skipped: number;
    results: Array<{ key: string; ok: boolean; probed: boolean; signal?: string; reason?: string; attempts: number }>;
  }> {
    if (!this.session || !this.registry || !this.gameSlug) {
      return { ok: false, reason: "no active session", probed: 0, verified: 0, failed: 0, skipped: 0, results: [] };
    }
    // Pre-flight: ensure on main before probing (a leftover popup would
    // sabotage every probe — main-state recovery is the runner's job here).
    const pre = await this.waitForMainScreen({ maxWaitMs: 30_000 });
    if (!pre.onMain) {
      return { ok: false, reason: `not on main before probe (${pre.reason ?? "unknown"})`, probed: 0, verified: 0, failed: 0, skipped: 0, results: [] };
    }

    const allCandidates: Array<[string, UiElement]> = [];
    for (const [key, el] of Object.entries(this.registry)) {
      if (!el) continue;
      if (opts.onlyKeys && !opts.onlyKeys.includes(key)) continue;
      if (el.status !== "pending") continue;
      allCandidates.push([key, el]);
    }

    // Split: canonical (key has NO `__`) vs sub-state (namespaced via __).
    // Canonical probes assume game-on-main + look for kind-specific signals
    // (gameService response, popup OCR, bet display change). Sub-state probes
    // need the parent popup OPEN — handled in a separate sub-state loop
    // below that walks the FULL trigger chain (level 1 → 2 → 3 …) for each
    // candidate so probes can verify elements at any depth, not just
    // first-level popups.
    const candidates: Array<[string, UiElement]> = [];
    const subStateCandidates: Array<[string, UiElement]> = [];
    for (const [key, el] of allCandidates) {
      if (key.includes("__")) {
        subStateCandidates.push([key, el]);
      } else {
        candidates.push([key, el]);
      }
    }
    // Sort sub-state candidates by depth ascending (level 1 first, then 2,
    // then 3) — probing a parent before its descendants means the parent
    // is verified by the time we walk the chain, satisfying the
    // "trigger-chain fully verified" check below.
    subStateCandidates.sort(([a], [b]) => a.split("__").length - b.split("__").length);

    const results: Array<{ key: string; ok: boolean; probed: boolean; signal?: string; reason?: string; attempts: number }> = [];
    let probed = 0, verified = 0, failed = 0, skipped = 0;
    for (const [key, el] of candidates) {
      // Re-ensure main between probes (the previous popup-kind probe just
      // recovered, but be defensive — a slow dismiss could leak otherwise).
      await this.waitForMainScreen({ maxWaitMs: 15_000 }).catch(() => undefined);
      const r: ProbeResult = await probeElement(this.session.page, key, el);
      results.push({ key, ok: r.ok, probed: r.probed, signal: r.signal, reason: r.reason, attempts: r.attempts });
      if (!r.probed) { skipped++; continue; }
      probed++;
      if (r.ok) {
        verified++;
        if (r.finalCoord) { el.x = r.finalCoord.x; el.y = r.finalCoord.y; }
        el.status = "verified";
        el.verifiedBy = "probe";
        el.verifiedAt = new Date().toISOString();
        el.probeSignal = r.signal;
        this.verifyState[key] = "confirmed";
        console.log(`[manual/probe] ${key} VERIFIED via ${r.signal} (attempts=${r.attempts})`);
      } else {
        // Option B: probe failed (signal not seen after offset retries). For
        // CANONICAL keys we have a description for, invoke the stateful
        // crop-verify AGENT (Claude Agent SDK with conversation memory — the
        // agent iteratively crops + verifies + adjusts, learning from previous
        // attempts within ONE session). Then re-probe with the refined coord.
        const baseDescription = describeCanonicalElement(key);
        if (baseDescription) {
          // Enrich with spin anchor when spinButton has a finite coord.
          // Adjacent canonical buttons (autoButton, betPlus/Minus) commonly
          // drift onto spin without a measurable reference. The agent's
          // description now carries "spinButton is at (X, Y); your target is
          // ~80px right of it" which materially cuts the drift rate.
          const spinCoord =
            this.registry.spinButton && Number.isFinite(this.registry.spinButton.x) && Number.isFinite(this.registry.spinButton.y)
              ? { x: this.registry.spinButton.x, y: this.registry.spinButton.y }
              : null;
          const description = enrichDescriptionWithSpinAnchor(key, baseDescription, spinCoord);
          console.log(`[manual/probe] ${key} probe failed — invoking stateful crop-verify agent${spinCoord && key !== "spinButton" ? ` (anchor=spin@(${spinCoord.x},${spinCoord.y}))` : ""}…`);
          await this.waitForMainScreen({ maxWaitMs: 15_000 }).catch(() => undefined);
          const cdpEndpoint = this.session.cdpEndpoint;
          let cv: AgentLocateResult;
          if (!cdpEndpoint) {
            cv = { ok: false, reason: "no CDP endpoint on session — cannot run Playwright-MCP agent" };
          } else {
            try {
              cv = await cropVerifyAgent({ description, label: key, cdpEndpoint, outputDir: path.join(dirForGame(this.gameSlug), "debug-agent") });
            } catch (err) {
              cv = { ok: false, reason: err instanceof Error ? err.message : String(err) };
            }
          }
          if (cv.ok && typeof cv.x === "number" && typeof cv.y === "number") {
            const moved = Math.abs(cv.x - el.x) > 5 || Math.abs(cv.y - el.y) > 5;
            if (moved) {
              el.x = cv.x;
              el.y = cv.y;
              el.strategy = "ai_vision";
              el.confidence = 0.85; // agent converged on a verified-centered crop
              console.log(`[manual/probe] ${key} agent refined → (${cv.x},${cv.y}) turns=${cv.turnsUsed ?? "?"}; re-probing…`);
              await this.waitForMainScreen({ maxWaitMs: 15_000 }).catch(() => undefined);
              const r2 = await probeElement(this.session.page, key, el);
              if (r2.ok) {
                verified++;
                if (r2.finalCoord) { el.x = r2.finalCoord.x; el.y = r2.finalCoord.y; }
                el.status = "verified";
                el.verifiedBy = "probe";
                el.verifiedAt = new Date().toISOString();
                el.probeSignal = `${r2.signal} (via crop-verify agent fallback)`;
                this.verifyState[key] = "confirmed";
                const row = results[results.length - 1]!;
                row.ok = true;
                row.signal = el.probeSignal;
                row.reason = undefined;
                console.log(`[manual/probe] ${key} VERIFIED after agent refine (signal=${r2.signal})`);
                continue;
              }
              console.log(`[manual/probe] ${key} still fails after agent refine — stays pending`);
            } else {
              console.log(`[manual/probe] ${key} agent returned same coord (drift ≤ 5px) — skipping re-probe`);
            }
          } else {
            console.log(`[manual/probe] ${key} agent did not commit a coord — ${cv.reason ?? "unknown"}`);
          }
        }
        failed++;
        console.log(`[manual/probe] ${key} stays pending — ${r.reason} (attempts=${r.attempts})`);
      }
    }

    // Sub-state pass — multi-level trigger-chain navigation. For each
    // candidate key like "paytableButton__nextPageButton__symbolButton" the
    // chain is ["paytableButton", "paytableButton__nextPageButton"]: click
    // them in sequence from main and we end up in the state where
    // symbolButton lives. After probing, dismiss everything so the next
    // candidate starts from main again.
    //
    // Why per-candidate (not per-trigger group): probing one element in a
    // popup can flip a toggle / advance a page / open a sub-popup. The next
    // candidate's coord was discovered against the ORIGINAL popup baseline,
    // not the post-click state. Re-opening from main between probes is the
    // simplest way to guarantee a clean baseline — slower but correct.
    //
    // Ordering: candidates were sorted by depth ascending above, so level-1
    // elements are probed BEFORE their level-2 descendants. By the time we
    // walk a level-3 chain like [A, A__B, A__B__C], A and A__B will have
    // been verified earlier in the same run.
    const triggerChainOf = (uiKey: string): string[] => {
      const parts = uiKey.split("__");
      if (parts.length < 2) return [];
      const chain: string[] = [];
      for (let i = 1; i < parts.length; i++) chain.push(parts.slice(0, i).join("__"));
      return chain;
    };

    for (const [key, el] of subStateCandidates) {
      const chain = triggerChainOf(key);
      // Verify every trigger in the chain is verified — clicking an
      // unverified trigger risks landing on a wrong button (e.g. spin →
      // costs real bet). If even one link is unverified, skip the
      // candidate; it'll get re-tried in a subsequent run after QA
      // verifies the parents.
      let chainOk = true;
      let badLink: string | null = null;
      for (const t of chain) {
        const tEl = this.registry[t];
        if (!tEl || (tEl.verifiedBy !== "QA" && tEl.verifiedBy !== "probe")) {
          chainOk = false;
          badLink = t;
          break;
        }
      }
      if (!chainOk) {
        results.push({ key, ok: false, probed: false, reason: `trigger chain broken at "${badLink}" (not verified)`, attempts: 0 });
        skipped++;
        continue;
      }

      // Ensure main → walk trigger chain → probe → dismiss.
      const main1 = await this.waitForMainScreen({ maxWaitMs: 15_000 }).catch(() => undefined);
      if (!main1 || !main1.onMain) {
        results.push({ key, ok: false, probed: false, reason: "couldn't reach main before opening popup chain", attempts: 0 });
        skipped++;
        continue;
      }
      let navOk = true;
      for (const t of chain) {
        const tEl = this.registry[t]!;
        try {
          await this.session.page.mouse.click(tEl.x, tEl.y);
          await this.session.page.waitForTimeout(2000);
        } catch (err) {
          results.push({ key, ok: false, probed: false, reason: `chain nav click failed at "${t}": ${err instanceof Error ? err.message : String(err)}`, attempts: 0 });
          navOk = false;
          break;
        }
      }
      if (!navOk) {
        skipped++;
        try { await dismissPopupsLoop(this.session.page, { maxAttempts: 3 }); } catch {}
        continue;
      }
      if (chain.length > 1) {
        console.log(`[manual/probe] navigating ${chain.length}-deep chain for ${key}: ${chain.join(" → ")}`);
      }

      // Verify via AI agent (2026-06-01 — replaces pixel-diff probe).
      // The agent clicks the coord ONCE, screenshots before/after, reads
      // recent network requests, and reasons about whether the response
      // matches the expected behavior derived from the key name. This is
      // the same observe-and-judge pattern the upstream code-gen tool
      // (logic-data-crawler-creator) uses, adapted to per-element
      // verification.
      //
      // WHY agent over pixel-diff: pixel-diff just measures "did the
      // screen change", which 10+ ghost namespaces in the previous run
      // exploited — clicking at wrong coord still produced visible
      // change (canvas tap → spin, click on spin coord through namespace
      // → reels spin → 67.9% pixDiff falsely "verified"). The agent
      // reads the SAME signals a human QA would (screenshot, network)
      // and rejects ghost responses ("you clicked spinButton again,
      // not a sub-state element"). No hardcoded threshold can substitute
      // for that judgment.
      let finalResult: ProbeResult;
      let agentTurns: number | undefined;
      if (!this.session.cdpEndpoint) {
        finalResult = { ok: false, probed: false, attempts: 0, reason: "no CDP endpoint — cannot run verify agent" };
      } else {
        const stateContext = chain.length > 0
          ? `Inside the popup opened by the trigger chain: ${chain.join(" → ")}.`
          : undefined;
        const expectedBehavior = expectedBehaviorFor(key);
        try {
          const v = await verifyClickAgent({
            cdpEndpoint: this.session.cdpEndpoint,
            coord: { x: el.x, y: el.y },
            elementKey: key,
            expectedBehavior,
            stateContext,
            outputDir: path.join(dirForGame(this.gameSlug), "debug-agent"),
          });
          agentTurns = v.turnsUsed;
          if (v.ok) {
            finalResult = {
              ok: true,
              probed: true,
              signal: `agentVerified: ${v.reason.slice(0, 120)}`,
              attempts: 1,
              finalCoord: { x: el.x, y: el.y },
            };
          } else {
            finalResult = {
              ok: false,
              probed: true,
              attempts: 1,
              reason: `agent rejected: ${v.reason.slice(0, 160)}`,
            };
          }
        } catch (err) {
          finalResult = {
            ok: false,
            probed: true,
            attempts: 1,
            reason: `agent threw: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      results.push({ key, ok: finalResult.ok, probed: finalResult.probed, signal: finalResult.signal, reason: finalResult.reason, attempts: finalResult.attempts });
      if (!finalResult.probed) {
        skipped++;
      } else if (finalResult.ok) {
        probed++;
        verified++;
        if (finalResult.finalCoord) { el.x = finalResult.finalCoord.x; el.y = finalResult.finalCoord.y; }
        el.status = "verified";
        el.verifiedBy = "probe";
        el.verifiedAt = new Date().toISOString();
        el.probeSignal = finalResult.signal;
        this.verifyState[key] = "confirmed";
        console.log(`[manual/probe] ${key} VERIFIED via agent (turns=${agentTurns ?? "?"}): ${finalResult.signal}`);
      } else {
        probed++;
        failed++;
        console.log(`[manual/probe] ${key} stays pending (turns=${agentTurns ?? "?"}) — ${finalResult.reason}`);
      }
      // Aggressive state recovery between sub-state probes (2026-06-01 — max
      // quality requirement). A single dismissPopupsLoop is not enough when
      // the agent's click triggered a real action with delayed side-effects:
      //   - startAutoplayButton → autoplay loop fires N spins; until stopped,
      //     every subsequent probe sees autoplay state instead of expected
      //     parent popup and gets rejected on context mismatch.
      //   - confirmButton (buy bonus) → free-spin chain starts; chain takes
      //     5-15 minutes to play out by itself.
      //   - Any click that opens a popup chain → may need ESC + corner-click
      //     multiple times.
      //
      // forceRecoverToMain loops: stopAutoplayIfActive (catches auto-spin),
      // waits for FS chain to end (OCR no longer matches "free spins"
      // without popup-content discriminators), dismisses popups, and only
      // returns when game is verifiably on main. Times out at 15 min — at
      // that point caller logs and moves on (rare edge case where game
      // is stuck and QA must intervene).
      try {
        await this.forceRecoverToMain({ maxWaitMs: 15 * 60 * 1000 });
      } catch (err) {
        console.warn(`[manual/probe] force-recover after ${key} threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await uiRegistry.save(this.gameSlug, this.registry);
    return { ok: true, probed, verified, failed, skipped, results };
  }

  /**
   * Synthesize slider-stop chips for every trigger whose sub-state-hints have
   * a `sliderMarks` config (e.g. autoButton → autoCountSlide-{10,20,30,50,
   * 70,100,500,1000}). Reads the min/max anchor elements the AI detected,
   * interpolates the discrete values evenly between them, writes the chip
   * keys, then removes the raw anchors. Idempotent — chip keys already in the
   * registry are not overwritten. Used by both discoverSubState (per-row
   * Discover) and deepDiscover (Deep Discover / Auto-Onboard).
   */
  private async synthesizeSliderStopsForAllHints(): Promise<string[]> {
    const warnings: string[] = [];
    if (!this.gameSlug || !this.registry) return warnings;
    const hints = await resolveSubStateHints(this.gameSlug);
    let synthesizedAny = false;
    for (const [triggerKey, hint] of Object.entries(hints)) {
      const sm = hint.sliderMarks;
      if (!sm) continue;
      const minEl = this.registry[`${triggerKey}__${sm.minAnchor}`];
      const maxEl = this.registry[`${triggerKey}__${sm.maxAnchor}`];
      if (!minEl || !maxEl || sm.values.length === 0) {
        const msg = `slider-synth ${triggerKey}: anchors not found (min=${!!minEl} max=${!!maxEl}) — ${sm.keyPrefix}-N chips NOT registered. Re-run Discover on ${triggerKey} row, or Pick the missing anchor(s) manually.`;
        console.warn(`[manual/slider-synth] ${msg}`);
        warnings.push(msg);
        continue;
      }
      const stops = interpolateSliderStops(minEl, maxEl, sm.values);
      const now = new Date().toISOString();
      let added = 0;
      for (const stop of stops) {
        const key = `${triggerKey}__${sm.keyPrefix}-${stop.value}`;
        if (this.registry[key]) continue;
        this.registry[key] = {
          x: stop.x,
          y: stop.y,
          strategy: "ai_vision",
          confidence: 0.4,
          detectedAt: now,
          status: "pending",
        };
        this.verifyState[key] = "pending";
        added++;
      }
      // Remove the raw anchors so the chips supersede them.
      delete this.registry[`${triggerKey}__${sm.minAnchor}`];
      delete this.registry[`${triggerKey}__${sm.maxAnchor}`];
      delete this.verifyState[`${triggerKey}__${sm.minAnchor}`];
      delete this.verifyState[`${triggerKey}__${sm.maxAnchor}`];
      console.log(`[manual/slider-synth] ${triggerKey}: synthesized ${added}/${sm.values.length} ${sm.keyPrefix}-{${sm.values.join(",")}} between anchors`);
      synthesizedAny = true;
    }
    if (synthesizedAny) await uiRegistry.save(this.gameSlug, this.registry);
    return warnings;
  }

  /**
   * P2 of AI auto-discover — recursive deep exploration. Reuses the cold-start
   * `exploreUiGraph` (DFS with safe-click whitelist, state hashing/dedup,
   * navigate-back, bounded by maxDepth/maxAiCalls/maxStates). After the explorer
   * merges newly-discovered states' elements into the registry, we auto-probe
   * any probeable new keys via `probePendingElements` (P1 chain). End result:
   * one click → graph of UI states explored → elements auto-verified where
   * possible → only un-probeable elements left pending for QA.
   */
  async deepDiscover(
    opts: { maxDepth?: number; maxAiCalls?: number; maxStates?: number; triggerHints?: Record<string, string> } = {},
  ): Promise<{
    ok: boolean;
    reason?: string;
    addedKeys?: string[];
    statesDiscovered?: number;
    transitionsRecorded?: number;
    aiCallsUsed?: number;
    elapsedMs?: number;
    warnings?: string[];
    /** Per-key explanation of why the explorer did or didn't try a click.
     *  Critical for diagnosing "0 elements discovered" — usually means every
     *  registry key was skipped by the safe-click whitelist. */
    safetyReport?: { clickable: string[]; skipped: Array<{ key: string; reason: string }> };
    probe?: Awaited<ReturnType<typeof this.probePendingElements>>;
  }> {
    if (!this.session || !this.registry || !this.gameSlug) {
      return { ok: false, reason: "no active session" };
    }
    const pre = await this.waitForMainScreen({ maxWaitMs: 30_000 });
    if (!pre.onMain) return { ok: false, reason: `not on main before deep-discover (${pre.reason ?? "unknown"})` };

    // Re-detect policy (2026-05-29): Deep Discover treats unverified entries as
    // stale candidates from prior AI runs and CLEARS them before re-detecting.
    // QA-verified and probe-verified entries are preserved as ground truth.
    const cleared: string[] = [];
    for (const [key, el] of Object.entries(this.registry)) {
      if (!el) continue;
      if (el.verifiedBy === "QA" || el.verifiedBy === "probe") continue;
      delete this.registry[key];
      delete this.verifyState[key];
      cleared.push(key);
    }
    if (cleared.length > 0) {
      await uiRegistry.save(this.gameSlug, this.registry);
      console.log(`[manual/deep-discover] cleared ${cleared.length} unverified entries for re-detection: ${cleared.slice(0, 8).join(",")}${cleared.length > 8 ? "…" : ""}`);
    }

    // Seed main-screen via AI vision when canonical keys are missing — lets
    // Start session be cheap (browser only) and concentrate ALL AI work in this
    // deep-discover / auto-onboard flow. Captured AFTER the clear so re-detected
    // keys count as `addedKeys` and downstream probe runs on them.
    const before = new Set(Object.keys(this.registry));
    // Seed main-screen via batch ai-vision (one call returns all detected
    // elements). Fast — ~5-10s. The trade-off vs the crop-verify locator is
    // coord drift (~10-50px on canvas slots), which is handled DOWNSTREAM by
    // the probe step + a crop-verify fallback when probe fails (Option B
    // 2026-05-30). Verified entries (QA/probe) are preserved.
    const CANONICAL_MAIN = ["spinButton", "betPlus", "betMinus", "menuButton", "paytableButton", "autoButton", "buyBonusButton", "historyButton"];
    const missingCanonical = CANONICAL_MAIN.filter((k) => {
      const el = this.registry[k];
      if (!el) return true;
      return el.verifiedBy !== "QA" && el.verifiedBy !== "probe";
    });
    if (missingCanonical.length > 0) {
      console.log(`[manual/deep-discover] ${this.gameSlug}: missing canonical main keys [${missingCanonical.join(",")}] — waiting for canvas to settle before AI seed…`);
      try {
        await waitUntilStable(this.session.page, {
          maxIterations: 10,
          changeThreshold: 0.01,
          consecutiveStable: 2,
        });
      } catch (err) {
        console.warn(`[manual/deep-discover] waitUntilStable warning: ${err instanceof Error ? err.message : String(err)}`);
      }
      await this.session.page.waitForTimeout(2000);
      console.log(`[manual/deep-discover] canvas settled — running AI vision`);
      const prevVerify = process.env.QA_UI_VERIFY_LOOP;
      process.env.QA_UI_VERIFY_LOOP = "0";
      try {
        const { uiMap } = await discoverUi(this.session.page, { slug: this.gameSlug });
        let seededCount = 0;
        for (const [key, el] of Object.entries(uiMap)) {
          if (!el) continue;
          const existing = this.registry[key];
          if (existing && (existing.verifiedBy === "QA" || existing.verifiedBy === "probe")) continue;
          this.registry[key] = el;
          this.verifyState[key] = "pending";
          seededCount++;
        }
        await uiRegistry.save(this.gameSlug, this.registry);
        console.log(`[manual/deep-discover] seeded ${seededCount} main-screen elements (verified entries preserved): ${Object.keys(uiMap).slice(0, 12).join(",")}${Object.keys(uiMap).length > 12 ? "…" : ""}`);
        if (seededCount === 0 && Object.keys(this.registry).length === 0) {
          return {
            ok: false,
            reason: "AI seeded 0 elements — the game canvas may still be loading or the screen is unrecognizable. Wait 10–20s after Start, then try again.",
          };
        }

        // Cluster check (2026-05-31). The batch AI-vision occasionally returns
        // a tight cluster of canonical coords (≥3 within ~80px), which is
        // virtually always a vision-failure mode — real slot UIs spread main
        // controls across the bottom row. When that happens, every cluster
        // entry will fail probe AND the crop-verify fallback gets pulled
        // toward the same wrong region (one wrong neighbor → same wrong
        // coord). Detect it here and re-discover the cluster keys per-element
        // BEFORE probe runs, so each element gets the agent's full attention
        // with a clean spinButton anchor.
        //
        // Hybrid policy: batch is the default path (cheap, usually correct);
        // per-element kicks in ONLY when the cluster heuristic trips. Cost
        // stays low on healthy games; recovery is automatic on broken ones.
        const cluster = detectCanonicalCluster(this.registry, CANONICAL_MAIN);
        if (cluster.detected && this.session.cdpEndpoint) {
          console.warn(
            `[manual/deep-discover] batch seed produced suspicious cluster: ` +
            `[${cluster.keys.join(",")}] within 80px of centroid (${cluster.centroid?.x},${cluster.centroid?.y}) — ` +
            `re-discovering per-element with spinButton anchor`,
          );
          // Clear the cluster entries (verified ones stay; cluster detection
          // already excluded them). Per-element will rebuild from scratch
          // with crop-verify agent.
          for (const k of cluster.keys) {
            delete this.registry[k];
            delete this.verifyState[k];
          }
          const pe = await discoverCanonicalPerElement(this.session.page, {
            cdpEndpoint: this.session.cdpEndpoint,
            existingRegistry: this.registry,
            onlyKeys: cluster.keys,
            outputDir: path.join(dirForGame(this.gameSlug), "debug-agent"),
          });
          for (const [key, el] of Object.entries(pe.registry)) {
            if (!el) continue;
            // Preserve any QA/probe-verified entry from this.registry — pe
            // already skipped overwriting them, but guard here too in case
            // verification raced.
            const existing = this.registry[key];
            if (existing && (existing.verifiedBy === "QA" || existing.verifiedBy === "probe")) continue;
            this.registry[key] = el;
            this.verifyState[key] = this.verifyState[key] ?? "pending";
          }
          await uiRegistry.save(this.gameSlug, this.registry);
          console.log(
            `[manual/deep-discover] per-element re-discovery: ` +
            `discovered=[${pe.discovered.join(",")}] notFound=[${pe.notFound.join(",")}] failed=${pe.failed.length}`,
          );
        }
      } finally {
        if (prevVerify === undefined) delete process.env.QA_UI_VERIFY_LOOP;
        else process.env.QA_UI_VERIFY_LOOP = prevVerify;
      }
    }

    // Pre-compute safe-click report so the user can SEE why exploration may
    // have nothing to click (e.g., all registry keys conservative-skipped).
    const safetyReport: { clickable: string[]; skipped: Array<{ key: string; reason: string }> } = {
      clickable: [],
      skipped: [],
    };
    for (const key of Object.keys(this.registry)) {
      const reason = explainSafety(key);
      if (reason === "safe") safetyReport.clickable.push(key);
      else safetyReport.skipped.push({ key, reason });
    }
    const aggressiveMode = process.env.QA_AGGRESSIVE_DISCOVER === "1";
    console.log(`[manual/deep-discover] ${this.gameSlug}: safety report — ${safetyReport.clickable.length} clickable, ${safetyReport.skipped.length} skipped (mode: ${aggressiveMode ? "AGGRESSIVE (QA_AGGRESSIVE_DISCOVER=1)" : "PRODUCTION-SAFE"})`);
    if (safetyReport.clickable.length === 0) {
      return {
        ok: false,
        reason: `no safe-to-click elements in registry — the explorer can't open anything to explore (${safetyReport.skipped.length} elements skipped). See safetyReport for details.`,
        safetyReport,
      };
    }

    // Pre-explorer canonical probe (2026-06-01). The explorer iterates the
    // safe-clickable canonical buttons and OPENS THEIR POPUPS to discover
    // sub-state elements. If the canonical coords are still WRONG at this
    // point (typical when batch AI vision misplaces them but the cluster
    // heuristic didn't trip — observed 2026-06-01 on vswaysmahwin2 where
    // spinButton was at (1130,685) but real was (985,685)), explorer clicks
    // miss every popup → popup-filter drops the AI-hallucinated main
    // elements → 0 sub-state in registry → no level 2 at all. Refining
    // canonical coords HERE — via the standard probe flow with agent
    // fallback — costs ~$3-8 extra but is the difference between a fully
    // populated registry and an empty one.
    const PRE_EXPLORE_CANONICAL = ["spinButton", "betPlus", "betMinus", "menuButton", "paytableButton", "autoButton", "buyBonusButton", "historyButton"];
    const preProbeKeys = PRE_EXPLORE_CANONICAL.filter((k) => {
      const el = this.registry[k];
      if (!el) return false;
      return el.status === "pending"; // verified entries skip
    });
    if (preProbeKeys.length > 0) {
      console.log(`[manual/deep-discover] ${this.gameSlug}: pre-explorer probe refining ${preProbeKeys.length} canonical: [${preProbeKeys.join(",")}]`);
      const preProbe = await this.probePendingElements({ onlyKeys: preProbeKeys });
      console.log(`[manual/deep-discover] pre-explorer probe done: verified=${preProbe.verified} failed=${preProbe.failed} skipped=${preProbe.skipped}`);
    }

    console.log(`[manual/deep-discover] ${this.gameSlug}: starting recursive UI graph exploration (depth<=${opts.maxDepth ?? 3}, aiCalls<=${opts.maxAiCalls ?? 25}, states<=${opts.maxStates ?? 15}, clickable=${safetyReport.clickable.join(",")})…`);
    // Per-trigger hints to pin AI labels to real values where the popup
    // contents are predictable. For bet selector (opened via betPlus or
    // betMinus), inject the exact gameSpec.betLadder so each bet cell is
    // labeled with a value that actually exists in the ladder — otherwise
    // the AI interpolates plausible-looking values like "bet-87.50" that
    // don't exist, and downstream agent-verify rejects every such probe.
    const triggerHints: Record<string, string> = {};
    if (this.gameSpec?.betLadder?.length) {
      const ladder = this.gameSpec.betLadder
        .map((v) => v.toFixed(2))
        .join(", ");
      const betHint =
        `This popup is the BET SELECTOR. Emit ONE element per VISIBLE bet ` +
        `button. The button shows a numeric bet value (often prefixed with $). ` +
        `READ the value rendered on each button and use key format "bet-<value>" ` +
        `where <value> is the number you READ (e.g. a button showing "$0.20" → ` +
        `key "bet-0.20"; "$100" → "bet-100.00"; format with 2 decimal places). ` +
        `For reference the game's full bet ladder is [${ladder}]. If a value ` +
        `you read is close to one of those, use the ladder value verbatim. ` +
        `Do NOT generate keys for values not visibly rendered on a button. ` +
        `Also emit "closeButton" for the X / dismiss control if visible.`;
      triggerHints["betPlus"] = betHint;
      triggerHints["betMinus"] = betHint;
    }
    // Inject per-trigger discoverHints from sub-state-hints (autoplay slider
    // anchors, paytable nextButton, menu historyButton, etc.). Without this
    // the explorer's AI runs unguided through autoButton → inconsistently
    // labels the slider track ends → slider-stop synthesis below silently
    // skips and autoCountSlide-N chips never register. Existing hints (bet
    // selector) take priority. See sub-state-hints.ts for the full list.
    const subHints = await resolveSubStateHints(this.gameSlug);
    for (const [triggerKey, hint] of Object.entries(subHints)) {
      if (!hint.discoverHint) continue;
      if (triggerHints[triggerKey]) continue;
      triggerHints[triggerKey] = hint.discoverHint;
    }
    const result = await exploreUiGraph(
      this.session.page,
      this.gameSlug,
      this.registry,
      { ...opts, triggerHints: { ...(opts.triggerHints ?? {}), ...triggerHints } },
    );

    // Migrate stale state-id-namespaced keys to trigger-namespaced. The explorer
    // now namespaces sub-state elements by the TRIGGER KEY (matching
    // discoverSubState's convention). Older runs used the AI-assigned state
    // label as namespace (e.g. autoplay_settings_popup__*). Re-running picks up
    // the same physical popup but creates new keys under the trigger → the
    // dashboard would show TWO duplicate groups. Rename the stale ones so the
    // tree groups everything under the trigger (autoButton__*).
    let migrated = 0;
    for (const fromStateId of Object.keys(result.graph.states ?? {})) {
      const fromState = result.graph.states[fromStateId];
      if (!fromState) continue;
      for (const [trigger, targetStateId] of Object.entries(fromState.transitions ?? {})) {
        if (!trigger || !targetStateId || trigger === targetStateId) continue;
        const stalePrefix = `${targetStateId}__`;
        const newPrefix = `${trigger}__`;
        if (stalePrefix === newPrefix) continue;
        for (const k of Object.keys(this.registry)) {
          if (!k.startsWith(stalePrefix)) continue;
          const tail = k.slice(stalePrefix.length);
          const newKey = newPrefix + tail;
          if (this.registry[newKey]) {
            // Conflict — fresh trigger-namespaced entry already exists from
            // this same explore. Stale loses; delete it.
            delete this.registry[k];
            delete this.verifyState[k];
          } else {
            this.registry[newKey] = this.registry[k];
            this.verifyState[newKey] = this.verifyState[k] ?? "pending";
            delete this.registry[k];
            delete this.verifyState[k];
          }
          migrated++;
        }
      }
    }
    if (migrated > 0) console.log(`[manual/deep-discover] migrated ${migrated} stale stateId-namespaced keys to trigger-namespaced`);

    // Merge new elements as pending. Explorer returns a mergedRegistry that
    // includes initial + all discovered; pick out the genuinely-new keys.
    const now = new Date().toISOString();
    const addedKeys: string[] = [];
    for (const [key, el] of Object.entries(result.registry)) {
      if (!el) continue;
      if (before.has(key)) continue;
      this.registry[key] = {
        ...el,
        status: el.status ?? "pending",
        detectedAt: el.detectedAt ?? now,
      };
      this.verifyState[key] = "pending";
      addedKeys.push(key);
    }
    await uiRegistry.save(this.gameSlug, this.registry);
    console.log(`[manual/deep-discover] explored ${result.graph.exploration.statesDiscovered} states, ${result.graph.exploration.transitionsRecorded} transitions, ${result.graph.exploration.aiCallsUsed} AI calls, +${addedKeys.length} new elements`);

    // Slider-stop synthesis: per-row Discover already does this in
    // discoverSubState; mirror here so Deep Discover (which goes through the
    // explorer, not discoverSubState) also synthesizes the discrete chips
    // (e.g. autoButton's autoCountSlide-{10,20,30,50,70,100,500,1000}).
    const synthWarnings = await this.synthesizeSliderStopsForAllHints();
    if (synthWarnings.length > 0) {
      (result.warnings ?? (result.warnings = [])).push(...synthWarnings);
    }

    // Auto-probe all pending probeable elements (P1 chain). With the new
    // re-detect policy (clear unverified at start), even keys that EXISTED
    // before but were re-seeded as pending should be re-probed — calling with
    // no `onlyKeys` filter scans the full registry and skips verified ones.
    const probe = await this.probePendingElements({});
    return {
      ok: true,
      addedKeys,
      statesDiscovered: result.graph.exploration.statesDiscovered,
      transitionsRecorded: result.graph.exploration.transitionsRecorded,
      aiCallsUsed: result.graph.exploration.aiCallsUsed,
      elapsedMs: result.graph.exploration.elapsedMs,
      warnings: result.warnings,
      safetyReport,
      probe,
    };
  }

  /**
   * P3 of AI auto-discover — one-click onboarding. Runs the full chain:
   *   1. deepDiscover (P2) — recursive UI graph exploration + element probe.
   *   2. calibratePayoutModel — multi-bet spins + payout-model derivation.
   * Returns combined summary. Skips PayoutModel calibration silently for
   * non-PP games (calibratePayoutModel will return ok=false with a reason).
   *
   * Note: paytable extraction is NOT part of auto-onboard in v1 — it's
   * performed during cold-start (`qa:cold`) and persisted to paytable.json.
   * If the game's paytable.json is stale/missing, payout calibration will
   * complete but with `paytableAgreement=false` → model untrusted (a safe,
   * informative outcome). Re-running cold-start is the path to refresh it.
   */
  async autoOnboard(
    opts: {
      deepDiscover?: { maxDepth?: number; maxAiCalls?: number; maxStates?: number };
      calibrationSpinsPerLevel?: number;
    } = {},
  ): Promise<{
    ok: boolean;
    reason?: string;
    discover?: Awaited<ReturnType<typeof this.deepDiscover>>;
    verify?: Awaited<ReturnType<typeof this.verifyRegistry>>;
    ocr?: Awaited<ReturnType<typeof this.autoDetectOcrRegions>> | { ok: false; reason: string; saved: never[]; proposed: never[]; skipped: never[] };
    payout?: Awaited<ReturnType<typeof this.calibratePayoutModel>>;
    testRun?: Awaited<ReturnType<typeof this.runAllTestcases>>;
  }> {
    if (!this.session || !this.registry || !this.gameSlug) {
      return { ok: false, reason: "no active session" };
    }
    // Mutex: reject if another autoOnboard is already running on this
    // session (handles queued duplicate HTTP requests that survived a
    // client-side TaskStop — server keeps processing them otherwise).
    if (this.autoOnboardInProgress) {
      console.warn(`[manual/auto-onboard] ${this.gameSlug}: REJECTED — another autoOnboard is already in progress (duplicate request likely queued)`);
      return { ok: false, reason: "another autoOnboard is already in progress for this session" };
    }
    this.autoOnboardInProgress = true;
    try {
      console.log(`[manual/auto-onboard] ${this.gameSlug}: starting — deep-discover → verify → payout`);

      // PARALLEL: kick off OCR-region auto-detection now using a baseline
      // screenshot of the (currently-main) game canvas. The detection chain
      // makes ~5 Claude vision calls + in-memory crops — completes in ~40s,
      // overlaps with deepDiscover's ~5-15 min runtime. No live screenshots
      // taken inside the chain, so deepDiscover's popup navigation can't
      // race against it. Failures here are non-fatal (returned in `ocr`).
      let ocrPromise: Promise<Awaited<ReturnType<typeof this.autoDetectOcrRegions>> | { ok: false; reason: string; saved: never[]; proposed: never[]; skipped: never[] }> = Promise.resolve(
        { ok: false, reason: "no baseline captured", saved: [], proposed: [], skipped: [] },
      );
      if (this.session) {
        try {
          const baseline = await this.session.page.screenshot({ type: "png" });
          ocrPromise = this.autoDetectOcrRegions({ baselineScreenshot: baseline }).catch((err) => ({
            ok: false as const,
            reason: err instanceof Error ? err.message : String(err),
            saved: [] as never[], proposed: [] as never[], skipped: [] as never[],
          }));
          console.log(`[manual/auto-onboard] ${this.gameSlug}: ocr-region detection running in parallel`);
        } catch (err) {
          console.warn(`[manual/auto-onboard] ${this.gameSlug}: baseline screenshot for OCR detection threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const discover = await this.deepDiscover(opts.deepDiscover ?? {});
      if (!discover.ok) {
        // Still await the parallel OCR detection so we don't leave a dangling
        // Claude call running in the background after we return.
        const ocr = await ocrPromise;
        return { ok: false, reason: `deep-discover failed: ${discover.reason ?? "unknown"}`, discover, ocr };
      }
      const ocr = await ocrPromise;
      console.log(`[manual/auto-onboard] ${this.gameSlug}: ocr-region detection done — saved=${ocr.saved.length} proposed=${ocr.proposed.length} skipped=${ocr.skipped.length}`);

      // Registry-verify phase (2026-06-02). After deep-discover, audit the
      // registry against the per-parent EXPECTED_CHILDREN rules: prune legacy
      // namespace dups, re-discover missing required/dynamic children via
      // discoverVia(), then bidirectionally mirror verified entries across
      // partner pairs (betPlus ↔ betMinus popup is identical). Bounded — one
      // discoverVia call per missing trigger, no infinite re-audit loops.
      const verify = await this.verifyRegistry();
      console.log(
        `[manual/auto-onboard] ${this.gameSlug}: verify — pruned=${verify.pruned.length} ` +
        `re-discovered=${verify.reDiscoveredTriggers.length} ` +
        `mirrored=${verify.mirrored.length}`,
      );

      let payout: Awaited<ReturnType<typeof this.calibratePayoutModel>>;
      try {
        payout = await this.calibratePayoutModel({ spinsPerLevel: opts.calibrationSpinsPerLevel });
      } catch (err) {
        payout = { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }

      // Phase 4 (2026-06-02): auto-run all test cases in the catalog. Skips
      // gracefully when the catalog doesn't exist yet (game hasn't been
      // cold-started for testcase-gen). For now, generation lives in
      // cold-start (`qa:cold` → generateAiCatalog with full network capture);
      // auto-onboard only RUNS the cases. Future: invoke a generator hook
      // here when AI catalog generation is decoupled from cold-start.
      const testRun = await this.runAllTestcases({ continueOnFail: true });
      console.log(
        `[manual/auto-onboard] ${this.gameSlug}: test-run ${testRun.ok ? "complete" : "skipped"}` +
        (testRun.ok ? ` — ${testRun.results.length} cases, ${testRun.passed} pass, ${testRun.failed} fail, ${testRun.skipped} skip` : ` — ${testRun.reason}`),
      );

      console.log(`[manual/auto-onboard] ${this.gameSlug}: done — discover.added=${discover.addedKeys?.length ?? 0} verify.mirrored=${verify.mirrored.length} ocr.saved=${ocr.saved.length} payout.trusted=${payout.trusted ?? false} test=${testRun.ok ? `${testRun.passed}/${testRun.results.length}p` : "skip"}`);
      return { ok: true, discover, verify, ocr, payout, testRun };
    } finally {
      this.autoOnboardInProgress = false;
    }
  }

  /**
   * Run every test case in the AI-generated catalog sequentially. Used as
   * the final step of `autoOnboard()`. Skips gracefully when the catalog
   * doesn't exist (game not yet cold-started for testcase gen).
   *
   * Returns per-case results + aggregated counts. When `continueOnFail` is
   * true (default), keeps running after a fail; when false, bails on first
   * non-pass. Each case runs through `previewCase()` so the standard
   * pre-flight ensure-main + post-case eval still applies.
   */
  async runAllTestcases(
    opts: { continueOnFail?: boolean; caseFilter?: (id: string) => boolean } = {},
  ): Promise<{
    ok: boolean;
    reason?: string;
    results: Array<{ caseId: string; status: string; durationMs: number; skipReason?: string }>;
    passed: number;
    failed: number;
    skipped: number;
  }> {
    if (!this.session || !this.gameSlug) {
      return { ok: false, reason: "no active session", results: [], passed: 0, failed: 0, skipped: 0 };
    }
    const catalog = await loadAiCatalog(this.gameSlug);
    if (!catalog) {
      return {
        ok: false,
        reason: "test-cases.json not found — run cold-start (qa:cold) to generate the catalog first",
        results: [], passed: 0, failed: 0, skipped: 0,
      };
    }
    const continueOnFail = opts.continueOnFail ?? true;
    const cases = catalog.cases.filter((c) => !opts.caseFilter || opts.caseFilter(c.id));
    const results: Array<{ caseId: string; status: string; durationMs: number; skipReason?: string }> = [];
    let passed = 0; let failed = 0; let skipped = 0;
    console.log(`[manual/run-all] ${this.gameSlug}: starting — ${cases.length} cases (continueOnFail=${continueOnFail})`);
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]!;
      console.log(`[manual/run-all] [${i + 1}/${cases.length}] ${c.id} (${c.severity ?? "?"}) — ${c.name}`);
      let runResult: Awaited<ReturnType<typeof this.previewCase>>;
      try {
        runResult = await this.previewCase(c.id, { ensureMain: true });
      } catch (err) {
        runResult = { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
      const status = runResult.result?.status ?? (runResult.ok ? "unknown" : "error");
      const durationMs = runResult.result?.durationMs ?? 0;
      results.push({ caseId: c.id, status, durationMs, skipReason: runResult.result?.skipReason });
      if (status === "pass") passed++;
      else if (status === "skip") skipped++;
      else failed++;
      console.log(`[manual/run-all] [${i + 1}/${cases.length}] ${c.id} → ${status} (${(durationMs / 1000).toFixed(1)}s)`);
      if (!continueOnFail && status === "fail") {
        console.log(`[manual/run-all] bailing after fail (continueOnFail=false)`);
        break;
      }
    }
    console.log(`[manual/run-all] ${this.gameSlug}: done — ${passed} pass / ${failed} fail / ${skipped} skip`);
    return { ok: true, results, passed, failed, skipped };
  }

  /**
   * Post-discover registry audit pass. Reads EXPECTED_CHILDREN rules to:
   *  1. Prune LEGACY_NAMESPACES dups (old discoverVia calls using stateLabel
   *     as prefix when canonical trigger-key prefix also exists).
   *  2. For each parent missing REQUIRED children, call discoverVia(trigger,
   *     trigger) to re-open the popup and discover its elements (then probe
   *     the new entries).
   *  3. For each parent below dynamicPrefix threshold (e.g. bet popup with
   *     <5 bet-X entries), same as #2.
   *  4. Bidirectionally mirror verified entries across mirrorPartner pairs
   *     (betPlus ↔ betMinus): if betMinus__bet-1.00 is verified and
   *     betPlus__bet-1.00 isn't, copy verification (same coord, same popup).
   *
   *  No iterative re-audit — runs each phase once, bounded.
   */
  async verifyRegistry(): Promise<{
    ok: boolean;
    pruned: string[];
    reDiscoveredTriggers: Array<{ trigger: string; addedKeys: string[]; reason?: string }>;
    mirrored: Array<{ from: string; to: string }>;
  }> {
    if (!this.registry || !this.gameSlug) {
      return { ok: false, pruned: [], reDiscoveredTriggers: [], mirrored: [] };
    }
    const { auditRegistry, applyMirrorRules, pruneLegacyNamespaces } = await import("../registry/expected-children.js");

    // Phase 1 — prune legacy-namespace dups.
    const pruned = pruneLegacyNamespaces(this.registry as Record<string, any>);
    if (pruned.length > 0) {
      console.log(`[manual/verify] pruned ${pruned.length} legacy-namespace dups: ${pruned.slice(0, 4).join(",")}${pruned.length > 4 ? ",…" : ""}`);
      for (const k of pruned) delete this.verifyState[k];
    }

    // Phase 2 — find missing required & dynamic-prefix gaps.
    const audit = auditRegistry(this.registry as Record<string, any>);
    const triggersToReDiscover = new Set<string>();
    for (const m of audit.missingRequired) triggersToReDiscover.add(m.trigger);
    for (const m of audit.missingDynamic) triggersToReDiscover.add(m.trigger);

    const reDiscoveredTriggers: Array<{ trigger: string; addedKeys: string[]; reason?: string }> = [];
    for (const trigger of Array.from(triggersToReDiscover)) {
      console.log(`[manual/verify] re-discovering ${trigger} children…`);
      try {
        const r = await this.discoverVia(trigger, trigger);
        if (r.ok) {
          reDiscoveredTriggers.push({ trigger, addedKeys: r.addedKeys ?? [] });
          // Probe the freshly added children so we know which actually work.
          if ((r.addedKeys?.length ?? 0) > 0) {
            try {
              await this.probePendingElements({ onlyKeys: r.addedKeys });
            } catch (err) {
              console.warn(`[manual/verify] probe new ${trigger} children threw: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } else {
          reDiscoveredTriggers.push({ trigger, addedKeys: [], reason: r.reason });
        }
      } catch (err) {
        reDiscoveredTriggers.push({ trigger, addedKeys: [], reason: err instanceof Error ? err.message : String(err) });
      }
      // Ensure we're back on main between re-discover invocations.
      try { await this.forceRecoverToMain({ maxWaitMs: 60_000 }); } catch {}
    }

    // Phase 3 — mirror partner pairs.
    const mirrored = applyMirrorRules(this.registry as Record<string, any>, new Date().toISOString());
    for (const m of mirrored) {
      this.verifyState[m.to] = "confirmed";
    }
    if (mirrored.length > 0) {
      console.log(`[manual/verify] mirrored ${mirrored.length} entries via partner-pair (e.g. ${mirrored[0]!.from} → ${mirrored[0]!.to})`);
    }

    await uiRegistry.save(this.gameSlug, this.registry);
    return { ok: true, pruned, reDiscoveredTriggers, mirrored };
  }

  /**
   * Invoke AI recover to suggest a new coord for a single element. QA reviewer
   * then [Click]s the proposed coord to verify; if right → [Confirm], if wrong
   * → [Manual] correction. Doesn't auto-save — QA decides.
   */
  async aiRecover(uiKey: string): Promise<{ ok: boolean; proposed?: { x: number; y: number; confidence: number }; reason?: string }> {
    if (!this.session || !this.registry) return { ok: false, reason: "no active session" };
    try {
      // Build context hint based on whether key is namespaced (sub-state):
      // - Main key (no "__") → no special context
      // - Namespaced (e.g. buy_feature_popup__closeButton) → tell AI a popup is open
      const isNamespaced = uiKey.includes("__");
      const stateLabel = isNamespaced ? uiKey.split("__")[0] : null;
      const contextHint = isNamespaced
        ? `A "${stateLabel}" popup/sub-screen is currently open on top of the main game. Find the element INSIDE that popup, NOT in the background main controls.`
        : undefined;

      const recovered = await aiRecoverLocator(this.session.page, uiKey, { contextHint });
      if (!recovered) return { ok: false, reason: "AI returned no coord — element may not be visible" };

      // STRICT VERIFY: re-check proposed coord with the verifier (crop +
      // describe-and-confirm AI call). Catches AI mistakes like proposing the
      // info "i" icon while we asked for menu "☰". verifier itself may refine
      // the coord across 2 more rounds before giving up.
      const bareKey = isNamespaced ? uiKey.split("__").slice(1).join("__") : uiKey;
      const hasVisualCheck = bareKey in ELEMENT_VISUAL_CHECK;
      let finalCoord = recovered;
      if (hasVisualCheck) {
        const fullBuf = await this.session.page.screenshot({ type: "png" });
        const debugDir = path.join(dirForGame(this.gameSlug), "debug-ai-recover");
        await mkdir(debugDir, { recursive: true });
        const verification = await verifyElement(
          this.session.page,
          bareKey,
          { x: recovered.x, y: recovered.y, confidence: recovered.confidence },
          fullBuf,
          debugDir,
        );
        if (!verification.verified || !verification.finalCoord) {
          const lastTrace = verification.trace[verification.trace.length - 1];
          const what = lastTrace ? lastTrace.what : "unknown";
          return {
            ok: false,
            reason: `AI proposed (${recovered.x},${recovered.y}) but verifier rejected after ${verification.rounds} rounds — actual content at that coord: "${what}". Try [Manual Coord] or re-take screenshot.`,
          };
        }
        // verifier may have refined to a better coord — use that
        finalCoord = {
          ...recovered,
          x: verification.finalCoord.x,
          y: verification.finalCoord.y,
          confidence: verification.finalCoord.confidence,
        };
      }

      // Sanity check for namespaced (popup) keys: reject coord if it overlaps
      // a known main-state element (AI probably saw through the popup).
      if (isNamespaced) {
        const COORD_OVERLAP_PX = 30;
        for (const [k, el] of Object.entries(this.registry)) {
          if (!el || k.includes("__")) continue;
          if (Math.abs(el.x - finalCoord.x) < COORD_OVERLAP_PX && Math.abs(el.y - finalCoord.y) < COORD_OVERLAP_PX) {
            return { ok: false, reason: `Coord (${finalCoord.x},${finalCoord.y}) overlaps main-state ${k} — popup likely not open. Re-open popup and retry.` };
          }
        }
      }

      // Update coord (status pending). QA verifies via [Click] then [Confirm].
      this.registry[uiKey] = {
        ...this.registry[uiKey],
        x: finalCoord.x,
        y: finalCoord.y,
        strategy: "ai_recover",
        confidence: finalCoord.confidence,
        status: "pending",
        detectedAt: finalCoord.detectedAt,
      };
      this.verifyState[uiKey] = "pending";
      return { ok: true, proposed: { x: finalCoord.x, y: finalCoord.y, confidence: finalCoord.confidence } };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Remove a registry entry (e.g. AI hallucinated, doesn't actually exist). */
  async removeElement(uiKey: string): Promise<void> {
    if (!this.session || !this.gameSlug || !this.registry) throw new Error("no active session");
    delete this.registry[uiKey];
    delete this.verifyState[uiKey];
    await uiRegistry.save(this.gameSlug, this.registry);
  }

  /**
   * Click-thru capture: QA clicks DIRECTLY in the Playwright Chrome window.
   * A capture-phase DOM listener intercepts the click → captures (clientX,
   * clientY) → saves to registry → preventDefault so the game doesn't react.
   *
   * Used when AI Recover keeps failing (e.g. menu icon too small / ambiguous).
   * QA just clicks the real button — no screenshot scaling, no manual coord
   * entry. Coord saved with strategy "manual" + verifiedBy: "QA".
   *
   * The listener registers with { once: true } so it auto-removes after one click.
   */
  async captureNextClick(uiKey: string, opts: { timeoutMs?: number; failIfExists?: boolean } = {}): Promise<{ ok: boolean; coord?: { x: number; y: number }; reason?: string }> {
    const timeoutMs = opts.timeoutMs ?? 30000;
    if (!this.session || !this.gameSlug || !this.registry) return { ok: false, reason: "no active session" };
    if (opts.failIfExists && this.registry[uiKey]) {
      return { ok: false, reason: `uiKey '${uiKey}' already exists — use Pick in Game on its row to update, or Remove first` };
    }
    const page = this.session.page;
    try {
      // Pass as plain JS string — TS function would carry esbuild's __name()
      // helper into the browser context and fail with "__name is not defined".
      const captureScript = `
        new Promise(function(resolve) {
          document.addEventListener('mousedown', function(e) {
            e.preventDefault();
            e.stopPropagation();
            resolve({ x: e.clientX, y: e.clientY });
          }, { capture: true, once: true });
        })
      `;
      const result = (await Promise.race([
        page.evaluate(captureScript),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms — no click captured`)), timeoutMs),
        ),
      ])) as { x: number; y: number };

      const now = new Date().toISOString();
      const existing = this.registry[uiKey];
      this.registry[uiKey] = {
        baselineScreenshot: existing?.baselineScreenshot,
        ...(existing ?? {}),
        x: Math.round(result.x),
        y: Math.round(result.y),
        strategy: "manual",
        confidence: 1.0,
        detectedAt: now,
        verifiedBy: "QA",
        status: "verified",
        verifiedAt: now,
      };
      this.verifyState[uiKey] = "confirmed";
      await uiRegistry.save(this.gameSlug, this.registry);
      return { ok: true, coord: { x: Math.round(result.x), y: Math.round(result.y) } };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Navigate the existing browser to a new URL — used when token changes
   * (gameUrl updated) so registry coords can be re-verified live without
   * destroying the session.
   */
  async navigateTo(newUrl: string): Promise<void> {
    if (!this.session) throw new Error("no active session");
    this.gameUrl = newUrl;
    await this.session.page.goto(newUrl, { waitUntil: "domcontentloaded" });
  }

  /** Take a fresh screenshot of the current browser state. */
  async screenshot(): Promise<Buffer | null> {
    if (!this.session) return null;
    return this.session.page.screenshot({ type: "png" });
  }

  /** Load current ocr-regions.json for the active game. Returns empty object
   *  when none exist yet (UI shows "no regions defined" state). */
  async loadOcrRegions(): Promise<{ ok: boolean; regions?: import("../registry/types.js").OcrRegions; reason?: string }> {
    const slug = this.gameSlug;
    if (!slug) return { ok: false, reason: "no active session" };
    const { ocrRegions } = await import("../registry/ocr-regions.js");
    const cur = await ocrRegions.load(slug);
    return { ok: true, regions: cur ?? {} };
  }

  /** Persist a region patch into ocr-regions.json (merge into existing).
   *  Caller passes one or more of balanceArea/betArea/winArea/freeSpinCounter
   *  as `{x, y, width, height}`. */
  async saveOcrRegion(
    key: "balanceArea" | "betArea" | "winArea" | "freeSpinCounter",
    region: { x: number; y: number; width: number; height: number },
  ): Promise<{ ok: boolean; regions?: import("../registry/types.js").OcrRegions; reason?: string }> {
    const slug = this.gameSlug;
    if (!slug) return { ok: false, reason: "no active session" };
    if (region.width <= 0 || region.height <= 0) return { ok: false, reason: "width and height must be positive" };
    const { ocrRegions } = await import("../registry/ocr-regions.js");
    const cur = (await ocrRegions.load(slug)) ?? {};
    const next = { ...cur, [key]: region };
    await ocrRegions.save(slug, next);
    return { ok: true, regions: next };
  }

  /** AI auto-detect OCR-region bboxes via Claude vision. Takes a current
   *  screenshot, asks the model to locate the Balance / Bet / Win / FS-counter
   *  widgets, and merges the high-confidence results into ocr-regions.json
   *  (low-confidence ones are returned but NOT persisted — QA reviews them).
   *
   *  Replaces the manual "Draw bbox by clicking two corners" flow for games
   *  where these widgets are positioned conventionally. The endpoint stays
   *  available alongside Draw so QA can override AI guesses.
   *
   *  @param opts.regions  Subset of region keys to detect; defaults to all four.
   *  @param opts.minConfidence  Only persist regions with confidence ≥ this
   *    threshold (default 0.7). Lower-confidence picks come back as
   *    `proposed` for QA to review before saving.
   */
  async autoDetectOcrRegions(
    opts: {
      regions?: ReadonlyArray<"balanceArea" | "betArea" | "winArea" | "freeSpinCounter">;
      /** Pre-captured main-screen PNG. When provided, all crop verification
       *  is done in-memory against this buffer — no live `page.screenshot`
       *  calls. Used by `autoOnboard` to parallelise OCR-region detection
       *  with deep-discover (which is busy opening popups; concurrent
       *  page.screenshot would race against its state changes). */
      baselineScreenshot?: Buffer;
    } = {},
  ): Promise<{
    ok: boolean;
    reason?: string;
    saved: Array<{ key: string; region: { x: number; y: number; width: number; height: number }; visionConfidence: number; aiValueRead: string | null; aiReason: string; ocrText?: string; ocrParsed?: number | null }>;
    proposed: Array<{ key: string; region: { x: number; y: number; width: number; height: number }; visionConfidence: number; aiValueRead: string | null; aiReason: string; ocrText?: string; ocrParsed?: number | null; rejectReason: string }>;
    skipped: Array<{ key: string; reason: string }>;
    regions?: import("../registry/types.js").OcrRegions;
  }> {
    if (!this.session || !this.gameSlug) {
      return { ok: false, reason: "no active session", saved: [], proposed: [], skipped: [] };
    }
    const page = this.session.page;
    // Use the caller-supplied baseline when present (parallel autoOnboard
    // path); otherwise grab a fresh shot (standalone dashboard call).
    const usingBaseline = Boolean(opts.baselineScreenshot);
    const shot = opts.baselineScreenshot ?? await page.screenshot({ type: "png" });
    const shotBase64 = shot.toString("base64");
    const vp = page.viewportSize() ?? { width: 1280, height: 720 };
    const { detectOcrRegions, verifyOcrRegionCrop } = await import("../../ai/detect-ocr-regions.js");
    const detection = await detectOcrRegions({ screenshotBase64: shotBase64, viewport: vp, regions: opts.regions });

    const saved: Array<{ key: string; region: { x: number; y: number; width: number; height: number }; visionConfidence: number; aiValueRead: string | null; aiReason: string; ocrText?: string; ocrParsed?: number | null }> = [];
    const proposed: Array<{ key: string; region: { x: number; y: number; width: number; height: number }; visionConfidence: number; aiValueRead: string | null; aiReason: string; ocrText?: string; ocrParsed?: number | null; rejectReason: string }> = [];
    const skipped: Array<{ key: string; reason: string }> = [];

    const { ocrRegions } = await import("../registry/ocr-regions.js");
    let merged: Record<string, any> = { ...((await ocrRegions.load(this.gameSlug)) ?? {}) };

    const NUMERIC_KEYS = new Set(["balanceArea", "betArea", "winArea"]);
    const MAX_REFINEMENT_ITERS = 3; // initial pick + up to 3 refinements

    for (const [key, entry] of Object.entries(detection)) {
      if (!entry) continue;
      if ((entry as { skipped?: boolean }).skipped) {
        skipped.push({ key, reason: (entry as { reason?: string }).reason ?? "skipped" });
        continue;
      }
      const r = entry as { x: number; y: number; width: number; height: number; confidence: number; reason: string };
      let bbox = { x: r.x, y: r.y, width: r.width, height: r.height };
      let visionConfidence = r.confidence;
      let visionReason = r.reason;
      let aiValueRead: string | null = null;
      let lastVerdictReason = "";
      let verified = false;
      const rejectedHistory: Array<{ bbox: { x: number; y: number; width: number; height: number }; reason: string }> = [];

      // CROP-AND-VERIFY LOOP with anti-oscillation + OCR ground-truth.
      // AI vision can hallucinate `value_read` ("I see $99,991,116.99" when
      // the crop is empty/wrong widget); we Tesseract-OCR the EXACT cropped
      // pixels AI approved and confirm the digits match before promoting
      // to `verified`. If AI says verified but OCR disagrees, treat as
      // rejected and feed the mismatch into rejectedHistory so the next
      // refinement aims somewhere new.
      const { ocrBuffer, parseNumericFromOcr } = await import("../utils/ocr-popup.js");
      let ocrText: string | undefined;
      let ocrParsed: number | null | undefined;

      for (let iter = 0; iter < MAX_REFINEMENT_ITERS + 1; iter++) {
        let cropBuf: Buffer;
        try {
          const clip = clampBboxForViewport(bbox, vp);
          cropBuf = usingBaseline
            ? cropPngBufferSync(shot, clip)
            : await page.screenshot({ type: "png", clip });
        } catch (err) {
          lastVerdictReason = `crop screenshot failed: ${err instanceof Error ? err.message : String(err)}`;
          break;
        }
        const verdict = await verifyOcrRegionCrop({
          cropBase64: cropBuf.toString("base64"),
          fullScreenshotBase64: shotBase64,
          bbox,
          region: key as "balanceArea" | "betArea" | "winArea" | "freeSpinCounter",
          viewport: vp,
          rejectedHistory,
        });
        lastVerdictReason = verdict.reason;
        aiValueRead = verdict.valueRead;

        if (verdict.verified) {
          // Ground-truth: Tesseract on the SAME crop. Numeric widgets must
          // yield a parseable number. FS counter just needs non-empty text.
          let groundTruthOk = true;
          let groundTruthDetail = "";
          try {
            const ocr = await ocrBuffer(cropBuf);
            ocrText = ocr.text;
            ocrParsed = parseNumericFromOcr(ocr.text);
            const isNumericKey = NUMERIC_KEYS.has(key);
            groundTruthOk = isNumericKey
              ? typeof ocrParsed === "number" && Number.isFinite(ocrParsed)
              : ocr.text.trim().length > 0;
            groundTruthDetail = `OCR read "${ocr.text.trim().slice(0, 80)}" (parsed=${ocrParsed ?? "null"})`;
          } catch (err) {
            groundTruthOk = false;
            groundTruthDetail = `Tesseract threw: ${err instanceof Error ? err.message : String(err)}`;
          }

          if (groundTruthOk) {
            verified = true;
            console.log(`[manual/ocr-region/auto-detect] ${this.gameSlug}: ${key} iter ${iter} VERIFIED — AI: "${aiValueRead}" / ${groundTruthDetail}`);
            break;
          }
          // AI claimed verified but Tesseract couldn't read a number → AI
          // hallucinated. Demote to rejected, feed back into history so the
          // next refinement aims away from this empty/wrong-widget bbox.
          console.warn(`[manual/ocr-region/auto-detect] ${this.gameSlug}: ${key} iter ${iter} AI said verified ("${aiValueRead}") but Tesseract DISAGREES (${groundTruthDetail}) — treating as REJECTED`);
          lastVerdictReason = `AI hallucinated value_read="${aiValueRead}" — Tesseract: ${groundTruthDetail}`;
          rejectedHistory.push({ bbox, reason: lastVerdictReason });
          if (iter === MAX_REFINEMENT_ITERS) break;
          // No AI-suggested refinement here (AI thought it was right), so
          // we widen the bbox by 50% and re-try in case the issue was a
          // too-tight crop clipping digits. Bail if widening doesn't help.
          const widened = {
            x: Math.max(0, Math.round(bbox.x - bbox.width * 0.25)),
            y: Math.max(0, Math.round(bbox.y - bbox.height * 0.25)),
            width: Math.round(bbox.width * 1.5),
            height: Math.round(bbox.height * 1.5),
          };
          // If widening would overlap a previously-rejected bbox, bail.
          const widenOverlaps = rejectedHistory.slice(0, -1).some((h) =>
            Math.abs(h.bbox.x - widened.x) <= 10 && Math.abs(h.bbox.y - widened.y) <= 10,
          );
          if (widenOverlaps) {
            console.log(`[manual/ocr-region/auto-detect] ${this.gameSlug}: ${key} widened bbox overlaps already-rejected — bailing`);
            break;
          }
          bbox = widened;
          continue;
        }

        if (!verdict.refinedBbox || iter === MAX_REFINEMENT_ITERS) break;

        // Anti-oscillation: reject refinement within ±10 px of a previously-
        // rejected bbox — AI is just looping on the same wrong place.
        const overlapsRejected = rejectedHistory.some((h) =>
          Math.abs(h.bbox.x - verdict.refinedBbox!.x) <= 10
          && Math.abs(h.bbox.y - verdict.refinedBbox!.y) <= 10,
        );
        if (overlapsRejected) {
          console.log(`[manual/ocr-region/auto-detect] ${this.gameSlug}: ${key} iter ${iter + 1} refined bbox overlaps already-rejected — bailing (no convergence)`);
          lastVerdictReason = `refinement oscillated near already-rejected bbox — no convergence (${verdict.reason})`;
          break;
        }
        rejectedHistory.push({ bbox, reason: verdict.reason });
        console.log(`[manual/ocr-region/auto-detect] ${this.gameSlug}: ${key} iter ${iter + 1} refining bbox → ${JSON.stringify(verdict.refinedBbox)} (${verdict.reason})`);
        bbox = verdict.refinedBbox;
      }

      const isNumericKey = NUMERIC_KEYS.has(key);
      const row = {
        key,
        region: bbox,
        visionConfidence,
        aiValueRead,
        aiReason: lastVerdictReason || visionReason,
        ocrText,
        ocrParsed,
      };
      if (verified) {
        merged[key] = bbox;
        saved.push(row);
      } else {
        const why = isNumericKey
          ? `AI rejected crop: ${lastVerdictReason || "unverified"}`
          : `AI could not verify crop: ${lastVerdictReason || "unverified"}`;
        proposed.push({ ...row, rejectReason: why });
      }
    }
    if (saved.length > 0) {
      await ocrRegions.save(this.gameSlug, merged as import("../registry/types.js").OcrRegions);
      console.log(`[manual/ocr-region/auto-detect] ${this.gameSlug}: AI vision-verified ${saved.length} regions (${saved.map((s) => `${s.key}→${s.aiValueRead ?? s.ocrParsed ?? "?"}`).join(", ")}); ${proposed.length} need review, ${skipped.length} skipped`);
    } else {
      console.log(`[manual/ocr-region/auto-detect] ${this.gameSlug}: no vision-verified picks — ${proposed.length} proposed for review, ${skipped.length} skipped`);
    }
    return { ok: true, saved, proposed, skipped, regions: merged as import("../registry/types.js").OcrRegions };
  }

  /** Delete one region entry from ocr-regions.json. */
  async removeOcrRegion(
    key: "balanceArea" | "betArea" | "winArea" | "freeSpinCounter",
  ): Promise<{ ok: boolean; regions?: import("../registry/types.js").OcrRegions; reason?: string }> {
    const slug = this.gameSlug;
    if (!slug) return { ok: false, reason: "no active session" };
    const { ocrRegions } = await import("../registry/ocr-regions.js");
    const cur = (await ocrRegions.load(slug)) ?? {};
    if (!(key in cur)) return { ok: true, regions: cur };
    const next: Record<string, unknown> = { ...cur };
    delete next[key];
    await ocrRegions.save(slug, next as import("../registry/types.js").OcrRegions);
    return { ok: true, regions: next as import("../registry/types.js").OcrRegions };
  }

  /** Test-fire OCR on a bbox without persisting — QA draws a rectangle, hits
   *  "Test", sees the OCR text + parsed number before committing the region. */
  async testOcrRegion(
    region: { x: number; y: number; width: number; height: number },
  ): Promise<{ ok: boolean; text?: string; parsedValue?: number | null; durationMs?: number; reason?: string }> {
    if (!this.session) return { ok: false, reason: "no active session" };
    if (region.width <= 0 || region.height <= 0) return { ok: false, reason: "width and height must be positive" };
    const { ocrRegion, parseNumericFromOcr } = await import("../utils/ocr-popup.js");
    try {
      const ocr = await ocrRegion(this.session.page, {
        x: region.x,
        y: region.y,
        w: region.width,
        h: region.height,
      });
      return {
        ok: true,
        text: ocr.text,
        parsedValue: parseNumericFromOcr(ocr.text),
        durationMs: ocr.durationMs,
      };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Pre-flight check used before running each test case in a batch — verify
   * the game is sitting on the main play screen, not stuck in a popup or
   * sub-state from the previous case. Two-layer detection (B + C):
   *   B1) OCR keywords: scan screenshot for "PAYTABLE", "CONGRATULATIONS",
   *       "BUY FEATURE", etc. → popup present.
   *   B2) Dark overlay: sample 4 corners' brightness — semi-transparent
   *       popup dimmer means main is covered.
   *   C)  Behavioral probe (opt-in): click spinButton, listen 3s for a
   *       /gameService response. Response → confirmed on main. No response
   *       within 3s → popup/frozen → not on main.
   *
   * Caller can request recovery via `autoRecover: true` — runs ESC×2 +
   * click corner + 1500ms wait, re-detects up to maxRecoverAttempts (2).
   *
   * @returns onMain: final verdict; details: each layer's result; recovered:
   *          true if was off-main but successfully returned via recovery.
   */
  async ensureMainScreen(opts: {
    probe?: boolean;
    autoRecover?: boolean;
    maxRecoverAttempts?: number;
  } = {}): Promise<{
    ok: boolean;
    onMain: boolean;
    recovered: boolean;
    layers: {
      ocr?: { hasPopup: boolean; matched: string[]; durationMs: number };
      overlay?: { overlayPresent: boolean; cornerBrightness: number[]; durationMs: number };
      probe?: { spinFired: boolean; durationMs: number };
    };
    reason?: string;
    attempts: number;
    /** True when off-main was due to a free-spin chain still playing (can't be
     *  dismissed — must wait for it to finish). Callers should poll/wait. */
    fsActive?: boolean;
  }> {
    if (!this.session) return { ok: false, onMain: false, recovered: false, layers: {}, reason: "no active session", attempts: 0 };
    const page = this.session.page;
    const maxAttempts = (opts.autoRecover === false ? 0 : (opts.maxRecoverAttempts ?? 2)) + 1;
    let fsActive = false;
    const layers: {
      ocr?: { hasPopup: boolean; matched: string[]; durationMs: number };
      overlay?: { overlayPresent: boolean; cornerBrightness: number[]; durationMs: number };
      probe?: { spinFired: boolean; durationMs: number };
    } = {};
    let recovered = false;
    // Resolve per-game popup keywords (defaults if no override)
    const popupKws = await resolvePopupKeywords(this.gameSlug);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Layer B1: OCR keyword scan
      const ocr = await detectAnyPopup(page, {
        interstitialKeywords: popupKws.interstitial,
        substateKeywords: popupKws.substate,
      });
      layers.ocr = { hasPopup: ocr.hasPopup, matched: ocr.matchedKeywords, durationMs: ocr.durationMs };
      console.log(`[ensure-main] attempt ${attempt} OCR: hasPopup=${ocr.hasPopup} matched=[${ocr.matchedKeywords.join(",")}] ms=${ocr.durationMs}`);

      // Layer B2: dark overlay sampler — reuse OCR screenshot to avoid a
      // second page.screenshot() call (each forces browser repaint in headed
      // mode → flicker). QA_SKIP_DARK_OVERLAY=1 disables this layer entirely.
      const overlay = process.env.QA_SKIP_DARK_OVERLAY === "1"
        ? { overlayPresent: false, cornerBrightness: [] as number[], durationMs: 0 }
        : await detectDarkOverlay(page, { sharedScreenshot: ocr.screenshot });
      layers.overlay = { overlayPresent: overlay.overlayPresent, cornerBrightness: overlay.cornerBrightness, durationMs: overlay.durationMs };
      console.log(`[ensure-main] attempt ${attempt} overlay: present=${overlay.overlayPresent} corners=[${overlay.cornerBrightness.join(",")}]`);

      // Overlay detector false-positives on games whose main UI has dark
      // corners (vs20rnriches, vsfiestamagenta…). Symptom: OCR consistently
      // reports no popup keywords but overlay flags present every attempt →
      // recover loop spins forever without making progress.
      // Policy: trust overlay on the FIRST attempt only (catches transient
      // dark popups + lets recovery try). On subsequent attempts, when OCR
      // remains "no popup", treat overlay as game-UI decoration and proceed.
      const overlayBlocking = overlay.overlayPresent && (attempt === 1 || ocr.hasPopup);
      const popupSignalB = ocr.hasPopup || overlayBlocking;
      if (overlay.overlayPresent && !overlayBlocking) {
        console.log(`[ensure-main] attempt ${attempt}: overlay still present but OCR clean — treating as game-UI decoration (not a popup), proceeding`);
      }

      // Distinguish an ACTIVE free-spin chain (FS counter / in-progress text,
      // no "press anywhere" dismiss affordance) from a dismissable popup. An
      // active FS chain CANNOT be dismissed (ESC/click won't stop it) — it must
      // play out. Flag it so we skip recovery + let the caller poll/wait.
      fsActive = isFreeSpinChainActive(ocr.matchedKeywords);

      // Layer C: behavioral probe (only when B says "clean" + opt-in)
      if (!popupSignalB && opts.probe === true) {
        const probe = await this.behavioralProbe();
        layers.probe = probe;
        console.log(`[ensure-main] attempt ${attempt} probe: spinFired=${probe.spinFired} ms=${probe.durationMs}`);
        if (probe.spinFired) {
          return { ok: true, onMain: true, recovered, layers, attempts: attempt };
        }
        // Probe failed → treat as off-main; fall through to recovery.
      } else if (!popupSignalB) {
        // B passed, probe not requested → trust B and proceed
        return { ok: true, onMain: true, recovered, layers, attempts: attempt };
      }

      // OFF MAIN → recover, UNLESS a free-spin chain is playing (don't ESC/click
      // an auto-playing chain — just let the caller wait it out).
      if (attempt < maxAttempts) {
        if (fsActive) {
          console.log(`[ensure-main] attempt ${attempt}: free-spin chain in progress → waiting (no dismiss)`);
        } else {
          recovered = true;
          await this.recoverToMain();
        }
      }
    }

    return {
      ok: false,
      onMain: false,
      recovered,
      layers,
      fsActive,
      reason: fsActive
        ? `free-spin chain still playing: ${layers.ocr?.matched.join(", ")}`
        : layers.ocr?.hasPopup
        ? `popup detected: ${layers.ocr.matched.join(", ")}`
        : layers.overlay?.overlayPresent
        ? `dark overlay covering corners [${layers.overlay.cornerBrightness.join(",")}]`
        : layers.probe && !layers.probe.spinFired
        ? "spinButton click did not fire a spin within 3s"
        : "unknown",
      attempts: maxAttempts,
    };
  }

  /**
   * Inter-case wait: poll ensureMainScreen on a 2s tick until we land on
   * the main play screen OR maxWaitMs elapses. Used instead of an arbitrary
   * fixed delay between cases — exits as soon as game is ready so fast cases
   * don't wait 60s, slow cases (free-spin cascade chain) get however long
   * they need within the cap.
   *
   * Returns total elapsed + final state so dashboard can report.
   */
  async waitForMainScreen(opts: { maxWaitMs?: number; pollMs?: number } = {}): Promise<{
    onMain: boolean;
    elapsedMs: number;
    polls: number;
    recoveredCount: number;
    reason?: string;
  }> {
    const maxWait = Math.max(2000, opts.maxWaitMs ?? 90_000);
    // Increased default from 2s → 5s to reduce screenshot frequency (each
    // poll = ~2 screenshots in headed mode → causes browser flicker).
    const pollMs = Math.max(500, opts.pollMs ?? 5000);
    const start = Date.now();
    let polls = 0;
    let recoveredCount = 0;
    while (Date.now() - start < maxWait) {
      polls++;
      const r = await this.ensureMainScreen({ probe: false, autoRecover: true, maxRecoverAttempts: 1 });
      if (r.recovered) recoveredCount++;
      if (r.onMain) {
        console.log(`[wait-for-main] onMain after ${Date.now() - start}ms (${polls} polls, ${recoveredCount} recoveries)`);
        return { onMain: true, elapsedMs: Date.now() - start, polls, recoveredCount };
      }
      // Wait remaining poll window before next check
      const elapsed = Date.now() - start;
      const remaining = maxWait - elapsed;
      if (remaining > 0) await this.session?.page.waitForTimeout(Math.min(pollMs, remaining));
    }
    return {
      onMain: false,
      elapsedMs: Date.now() - start,
      polls,
      recoveredCount,
      reason: `gave up after ${maxWait}ms — game stuck off-main`,
    };
  }

  /**
   * Recovery moves used when off-main detected:
   *   1. Try OCR auto-dismiss loop (handles "PRESS ANYWHERE TO CONTINUE" etc.)
   *   2. Press ESC × 2 (closes most modal popups)
   *   3. Click viewport corner (5, 5) — outside any centered popup
   *   4. Wait 1500ms for animations to settle
   * Doesn't return success; caller re-runs detection to verify.
   */
  /**
   * Detect + stop autoplay leaked from a prior session. Slot game servers
   * persist account state — if the previous QA browser exited mid-autoplay,
   * reopening the same game URL resumes spinning automatically. Manifests as
   * spontaneous /gameService POST responses with no QA input.
   *
   * Detection: watch for spontaneous spin responses for ~3s. Stop: click the
   * spinButton (shows STOP icon during autoplay) + dismiss the "Stop
   * Autoplay?" confirmation popup. If spinButton isn't registered yet (start()
   * before Discover), fall back to a viewport-center click.
   *
   * Called from start() + resume() after popup dismiss, before any operation
   * that assumes the game is idle. Adds ~3s when no autoplay (cheap insurance).
   */
  private async stopAutoplayIfActive(): Promise<{ wasActive: boolean }> {
    if (!this.session) return { wasActive: false };
    const page = this.session.page;
    let spinObserved = false;
    const handler = (res: import("playwright").Response) => {
      if (/gameService|doSpin/.test(res.url()) && res.request().method() === "POST") {
        spinObserved = true;
      }
    };
    page.on("response", handler);
    try {
      await page.waitForTimeout(3000);
    } finally {
      page.off("response", handler);
    }
    if (!spinObserved) return { wasActive: false };

    console.log("[manual/autoplay-stop] spontaneous gameService POST observed within 3s → autoplay likely active, stopping");
    const sb = this.registry?.spinButton;
    try {
      if (sb && Number.isFinite(sb.x) && Number.isFinite(sb.y)) {
        await page.mouse.click(sb.x, sb.y);
      } else {
        const vp = page.viewportSize() ?? { width: 1280, height: 720 };
        await page.mouse.click(Math.round(vp.width / 2), Math.round(vp.height / 2));
      }
      await page.waitForTimeout(2500);
    } catch (err) {
      console.warn(`[manual/autoplay-stop] click failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const r = await dismissPopupsLoop(page, { maxAttempts: 3 });
      if (r.attempts > 0) console.log(`[manual/autoplay-stop] post-stop popup dismiss: ok=${r.ok} attempts=${r.attempts}`);
    } catch {}
    // Verify autoplay actually stopped — if spins still firing, log loudly so
    // QA can intervene manually (don't loop here; the manual session can
    // continue once QA stops it via UI).
    let stillSpinning = false;
    const verifyHandler = (res: import("playwright").Response) => {
      if (/gameService|doSpin/.test(res.url()) && res.request().method() === "POST") {
        stillSpinning = true;
      }
    };
    page.on("response", verifyHandler);
    try {
      await page.waitForTimeout(2000);
    } finally {
      page.off("response", verifyHandler);
    }
    if (stillSpinning) {
      console.warn("[manual/autoplay-stop] autoplay still firing after stop attempt — QA intervention required");
    } else {
      console.log("[manual/autoplay-stop] autoplay successfully stopped");
    }
    return { wasActive: true };
  }

  /**
   * Aggressive state recovery — used between sub-state probes when the agent
   * verify click may have triggered a side-effect that persists past a single
   * dismissPopupsLoop call (autoplay loop, free-spin chain, nested popup
   * cascade). Loops until the game is verifiably back on the main play
   * screen OR maxWaitMs elapses.
   *
   * Steps per iteration:
   *   1. stopAutoplayIfActive — clicks the spin button (= STOP during
   *      autoplay) if spontaneous gameService POSTs are observed.
   *   2. dismissPopupsLoop — ESC + corner-click to close any popup.
   *   3. Re-check via OCR + overlay. If popup gone AND not a FS chain →
   *      return. If FS chain detected, wait 5s + retry (chains play out
   *      autonomously, can only be waited out).
   *
   * The 15-min default cap accommodates worst-case 100-spin autoplay or a
   * deep free-spin chain. Most recoveries finish in 5-30s.
   */
  private async forceRecoverToMain(opts: { maxWaitMs?: number } = {}): Promise<{ onMain: boolean; reason?: string; elapsedMs: number }> {
    if (!this.session) return { onMain: false, reason: "no session", elapsedMs: 0 };
    const page = this.session.page;
    const maxWaitMs = opts.maxWaitMs ?? 5 * 60 * 1000;
    const start = Date.now();
    let attempt = 0;
    // Stuck-popup detection (2026-06-01 — observed substate popups like the
    // autoplay settings panel survive dismissPopupsLoop's ESC+corner-click
    // strategy because they require explicit close-X clicks at game-specific
    // coords. detectAnyPopup sees them via substate keywords; dismissPopupsLoop
    // doesn't. Without an exit, the loop spins for the full maxWaitMs (15 min
    // by default) printing "ocr/popup-detect: hasPopup=false" lines forever).
    // If the SAME popup signature appears 3 iterations in a row AND it's not a
    // free-spin chain (chains naturally complete in time), bail out with
    // "stuck-substate" — caller logs and moves on. The loss is acceptable: a
    // single sub-state probe failing to recover its parent popup state means
    // its downstream candidates skip, but the rest of the registry still
    // progresses.
    let prevSignature = "";
    let unchangedCount = 0;
    while (Date.now() - start < maxWaitMs) {
      attempt++;
      // Phase 0: close any extra browser tabs the verify-click agent may have
      // opened (e.g. gameHistoryButton opens a new tab — without this, all
      // downstream probes see the history tab as the active page and reject
      // their parent-state context).
      try {
        const ctx = page.context();
        const pages = ctx.pages();
        if (pages.length > 1) {
          for (const p of pages) {
            if (p !== page) {
              try { await p.close(); } catch {}
            }
          }
          await page.bringToFront();
          console.log(`[force-recover] attempt ${attempt}: closed ${pages.length - 1} extra tab(s), restored game tab`);
        }
      } catch {}

      // Phase 1: stop autoplay if active.
      try {
        const a = await this.stopAutoplayIfActive();
        if (a.wasActive) {
          console.log(`[force-recover] attempt ${attempt}: autoplay stopped`);
        }
      } catch {}

      // Phase 2: dismiss popups.
      try {
        await dismissPopupsLoop(page, { maxAttempts: 3 });
      } catch {}

      // Phase 2.5: dismiss FREE SPINS COMPLETED result banner via Space/Enter.
      // OCR's suppressResultBannerMatches correctly classifies the COMPLETED
      // overlay as "on-main" (not a popup), so dismissPopupsLoop skips it.
      // But the overlay VISUALLY blocks canvas clicks — every subsequent
      // probe sees the COMPLETED banner instead of the expected popup
      // state. PP slot games typically dismiss it via Space/Enter without
      // triggering a spin (canvas-click would spin instead). Press once
      // per recovery attempt; harmless when banner is absent.
      try {
        const { ON_MAIN_RESULT_PHRASES } = await import("../utils/ocr-popup.js");
        const probe = await detectAnyPopup(page, { substateKeywords: [] });
        if (ON_MAIN_RESULT_PHRASES.some((p) => probe.detectedText.includes(p))) {
          console.log(`[force-recover] attempt ${attempt}: FS-completed banner detected — dismissing via Space/Enter`);
          await page.keyboard.press("Space");
          await page.waitForTimeout(800);
          await page.keyboard.press("Enter");
          await page.waitForTimeout(800);
        }
      } catch {}

      // Phase 3: verify clean main state.
      let det: Awaited<ReturnType<typeof detectAnyPopup>>;
      try {
        det = await detectAnyPopup(page, { substateKeywords: SUBSTATE_POPUP_KEYWORDS });
      } catch {
        await page.waitForTimeout(2000);
        continue;
      }
      if (!det.hasPopup) {
        // No popup signals → clean main.
        console.log(`[force-recover] attempt ${attempt}: clean main reached in ${Date.now() - start}ms`);
        return { onMain: true, elapsedMs: Date.now() - start };
      }
      // Popup signals present. Is it a free-spin chain (uncloseable)?
      const isFs = isFreeSpinChainActive(det.matchedKeywords);
      if (isFs) {
        // Reset unchanged-count: FS chains DO progress (we're not stuck, just
        // waiting for the chain to play out).
        unchangedCount = 0;
        prevSignature = "";
        console.log(`[force-recover] attempt ${attempt}: free-spin chain active (matched=[${det.matchedKeywords.join(",")}]) — waiting`);
        await page.waitForTimeout(5000);
        continue;
      }
      // Non-FS popup: check whether we're making progress (signature changes
      // each iteration) or stuck (same signature repeating).
      const signature = [...det.matchedKeywords].sort().join(",");
      if (signature === prevSignature) {
        unchangedCount++;
        if (unchangedCount >= 6) {
          console.warn(`[force-recover] STUCK on substate popup [${signature}] for ${unchangedCount} consecutive attempts — bailing out (ESC + corner-click can't dismiss this popup; needs an explicit close-X click QA must wire up)`);
          return {
            onMain: false,
            reason: `stuck on popup [${signature}] — dismissPopupsLoop cannot close it (substate popup needs game-specific close affordance)`,
            elapsedMs: Date.now() - start,
          };
        }
      } else {
        unchangedCount = 1;
        prevSignature = signature;
      }
      await page.waitForTimeout(1500);
    }
    return { onMain: false, reason: `timeout after ${Math.round((Date.now() - start) / 1000)}s`, elapsedMs: Date.now() - start };
  }

  private async recoverToMain(): Promise<void> {
    if (!this.session) return;
    const page = this.session.page;
    try {
      const r = await dismissPopupsLoop(page, { maxAttempts: 2 });
      if (r.attempts > 0) console.log(`[recover-main] ocr-dismiss ok=${r.ok} attempts=${r.attempts}`);
    } catch (err) {
      console.warn(`[recover-main] ocr-dismiss failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      await page.mouse.click(5, 5);
      await page.waitForTimeout(1500);
    } catch (err) {
      console.warn(`[recover-main] esc+corner failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Behavioral probe — click the spinButton at its registered coord, listen
   * 3s for any /gameService response. If a spin response fires → confirmed
   * on the main play screen (game accepted the spin). If not → either we're
   * on a popup that swallowed the click, or the game is frozen.
   *
   * Side effect: consumes one real spin (deducts bet from balance, increments
   * roundId). Caller decides whether the cost is worth the confirmation.
   */
  private async behavioralProbe(): Promise<{ spinFired: boolean; durationMs: number }> {
    const start = Date.now();
    if (!this.session || !this.registry?.spinButton) {
      return { spinFired: false, durationMs: Date.now() - start };
    }
    const page = this.session.page;
    const sb = this.registry.spinButton;
    let fired = false;
    const onResponse = (res: import("playwright").Response) => {
      if (/gameService|doSpin/.test(res.url())) fired = true;
    };
    page.on("response", onResponse);
    try {
      await page.mouse.click(sb.x, sb.y);
      // Poll for up to 3s with 100ms granularity so we exit as soon as a spin
      // is observed (no need to wait the full 3s when game is responsive).
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !fired) {
        await page.waitForTimeout(100);
      }
    } finally {
      page.off("response", onResponse);
    }
    return { spinFired: fired, durationMs: Date.now() - start };
  }

  /**
   * Resume a previously-registered game — open browser at saved gameUrl,
   * load existing ui-registry.json (no AI discovery). QA can continue
   * verifying / refining without re-running expensive discovery.
   */
  async resume(gameSlug: string): Promise<SessionStatus> {
    if (this.session) throw new Error("Session already active — call stop() first");
    const m = await meta.load(gameSlug);
    if (!m) throw new Error(`No registry for ${gameSlug}`);
    const reg = await uiRegistry.load(gameSlug);
    if (!reg) throw new Error(`No ui-registry.json for ${gameSlug}`);

    // Rename legacy namespace keys (autoplay_popup__* → autoButton__*) so
    // AI translator + tree + executor all see consistent path-style names.
    const renames = migrateLegacyNamespaces(reg);
    const renamedCount = renames.filter((r) => !r.skipped).length;
    if (renamedCount > 0) {
      console.log(`[manual] migrated ${renamedCount} legacy namespace keys on resume: ${renames.filter((r) => !r.skipped).slice(0, 5).map((r) => `${r.old}→${r.new}`).join(", ")}`);
      await uiRegistry.save(gameSlug, reg);
    }

    // Headed by default; QA_HEADLESS=1 to run headless on resume.
    this.session = await openBrowser(process.env.QA_HEADLESS === "1");
    this.gameUrl = m.gameUrl;
    this.gameSlug = gameSlug;
    this.startedAt = new Date().toISOString();
    this.registry = reg;
    this.discoveryAutoAdded = [];
    this.expectedElementKeys = (await resolveExpectedUiElements(gameSlug)).map((e) => e.key);
    this.lastBalance = null;
    this.attachBalanceTracker();
    // Restore verify state from persisted status field
    this.verifyState = {};
    for (const [k, el] of Object.entries(reg)) {
      if (!el) continue;
      this.verifyState[k] =
        el.status === "verified" ? "confirmed" :
        el.status === "rejected" ? "rejected" : "pending";
    }

    await crawl(this.session.page, { gameUrl: m.gameUrl, gameSlug });

    // OCR popup dismissal after resume (server-side state may still carry
    // celebration popup from previous session).
    try {
      await this.session.page.waitForTimeout(2000);
      const r = await dismissPopupsLoop(this.session.page);
      if (r.attempts > 0) console.log(`[manual/ocr] popup dismiss on resume: ok=${r.ok} attempts=${r.attempts} matched=${r.finalDetect.matchedKeywords.join(",")}`);
    } catch (err) {
      console.warn(`[manual/ocr] popup dismiss failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    // Same autoplay-leakage check as start() — server-side account state
    // commonly persists across browser sessions for slot platforms. Without
    // this, deep-discover sees autoplay-induced spin animations + the explorer
    // tries to interact with a moving target (observed 2026-05-30 on
    // vs20rnriches → explorer found `stop_autoplay_prompt` state instead of
    // autoplay's normal settings popup).
    try {
      const a = await this.stopAutoplayIfActive();
      if (a.wasActive) console.log(`[manual/autoplay-stop] stopped leaked autoplay on resume`);
    } catch (err) {
      console.warn(`[manual/autoplay-stop] failed on resume (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    return this.status();
  }

  /**
   * Load test cases + translated actions from disk for current game.
   * Returns one summary per case: id, name, category, severity, action count,
   * assertion count, and the actions themselves (for inspection). Used by
   * dashboard to render the Test Cases panel.
   */
  async listCases(slugOverride?: string): Promise<{ ok: boolean; cases?: Array<{
    id: string;
    name: string;
    category: string;
    severity: string;
    setupSummary: string;
    setupInstructions: string;
    actionCount: number;
    assertionCount: number;
    actions: unknown[];
    assertions: Array<{ id: string; description: string; check_code: string }>;
    skipReason?: string;
  }>; reason?: string }> {
    // Accept explicit slug so dashboard can list cases without active session
    // (read-only file lookups; Preview still requires active session).
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required (no active session or override)" };
    const catalog = await loadAiCatalog(slug);
    if (!catalog) return { ok: false, reason: `test-cases.json not found for ${slug} — run Generate Cases first` };
    const actionsCache = await loadActionsCache(slug);
    const out = catalog.cases.map((c) => {
      const translated = actionsCache?.cases[c.id];
      return {
        id: c.id,
        name: c.name,
        category: c.category,
        severity: c.severity,
        setupSummary: (c.setup_instructions ?? "").slice(0, 200),
        setupInstructions: c.setup_instructions ?? "",
        actionCount: translated?.actions.length ?? 0,
        assertionCount: c.custom_assertions?.length ?? 0,
        actions: translated?.actions ?? [],
        assertions: (c.custom_assertions ?? []).map((a) => ({
          id: a.id,
          description: a.description,
          check_code: a.check_code,
        })),
        skipReason: translated?.skipReason,
      };
    });
    return { ok: true, cases: out };
  }

  /**
   * Re-translate a single case: call AI translator with current registry +
   * setup_instructions. Used when initial translation skipped (e.g. missing
   * uiKey at translate time, but QA has since added that element via Discover).
   * Updates test-cases.actions.json on disk and returns new translation.
   */
  async retranslateCase(caseId: string, slugOverride?: string): Promise<{ ok: boolean; actions?: unknown[]; skipReason?: string; reason?: string; aiCalled?: boolean }> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required (no active session or override)" };
    const catalog = await loadAiCatalog(slug);
    if (!catalog) return { ok: false, reason: "test-cases.json not found" };
    const tc = catalog.cases.find((c) => c.id === caseId);
    if (!tc) return { ok: false, reason: `case ${caseId} not in catalog` };

    // Use current in-memory registry if active session for THIS slug, else load from disk.
    const reg = (this.gameSlug === slug && this.registry) ? this.registry : await uiRegistry.load(slug);
    if (!reg) return { ok: false, reason: "no registry available" };

    const translated = await translateCase({
      caseId: tc.id,
      caseName: tc.name,
      category: tc.category,
      setup: tc.setup_instructions ?? "",
      uiMap: reg,
      gameSpec: this.gameSpec ? {
        betLadder: this.gameSpec.betLadder,
        defaultBet: this.gameSpec.defaultBet,
        betMin: this.gameSpec.betMin,
        betMax: this.gameSpec.betMax,
      } : undefined,
      spinCount: tc.spin_count,
      customAssertions: tc.custom_assertions,
    });

    // Persist updated cache — strip aiCalled (in-call signal, not part of cache schema)
    const { aiCalled, ...persistable } = translated;
    const cache = (await loadActionsCache(slug)) ?? {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      cases: {},
    };
    cache.cases[caseId] = persistable;
    cache.generatedAt = new Date().toISOString();
    await saveActionsCache(slug, cache);

    return { ok: true, actions: translated.actions, skipReason: translated.skipReason, aiCalled };
  }

  /**
   * Return the cached translated actions for a case so the dashboard editor
   * can render them. Returns null actions when the case isn't in the cache
   * yet (translation never ran or was reset). Caller decides UX.
   */
  async getCaseActions(caseId: string, slugOverride?: string): Promise<{
    ok: boolean;
    caseId: string;
    actions: import("../step7-testcase-gen/case-action-translator.js").CaseAction[] | null;
    skipReason?: string;
    /** All uiKeys currently in the game's registry (so editor can validate
     *  click.uiKey + offer autocomplete). */
    availableUiKeys: string[];
    reason?: string;
  }> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, caseId, actions: null, availableUiKeys: [], reason: "no active session or override" };
    const cache = await loadActionsCache(slug);
    const reg = (this.gameSlug === slug && this.registry) ? this.registry : await uiRegistry.load(slug);
    const availableUiKeys = reg ? Object.keys(reg) : [];
    if (!cache || !cache.cases[caseId]) {
      return { ok: true, caseId, actions: null, availableUiKeys, reason: "case not in actions cache (run translate first)" };
    }
    const entry = cache.cases[caseId];
    return {
      ok: true,
      caseId,
      actions: entry.actions,
      skipReason: entry.skipReason,
      availableUiKeys,
    };
  }

  /**
   * Persist QA-edited actions for a case. Validates that each click action's
   * uiKey exists in the current registry; rejects the save if any is missing
   * (so we don't corrupt the cache with broken references). Bypasses AI —
   * QA's edit is final.
   */
  async saveCaseActions(
    caseId: string,
    actions: import("../step7-testcase-gen/case-action-translator.js").CaseAction[],
    slugOverride?: string,
  ): Promise<{ ok: boolean; reason?: string; invalidUiKeys?: string[] }> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required" };
    const reg = (this.gameSlug === slug && this.registry) ? this.registry : await uiRegistry.load(slug);
    if (!reg) return { ok: false, reason: "no registry available — can't validate uiKeys" };

    // Validate shape + uiKey references.
    if (!Array.isArray(actions)) return { ok: false, reason: "actions must be an array" };
    const invalidUiKeys: string[] = [];
    for (const a of actions) {
      if (!a || typeof a !== "object" || typeof (a as { kind: unknown }).kind !== "string") {
        return { ok: false, reason: "each action must be an object with a 'kind' field" };
      }
      if ((a as { kind: string }).kind === "click") {
        const uiKey = (a as { uiKey?: unknown }).uiKey;
        if (typeof uiKey !== "string" || uiKey.length === 0) {
          return { ok: false, reason: "click action requires a non-empty uiKey" };
        }
        if (!reg[uiKey]) invalidUiKeys.push(uiKey);
      }
      if ((a as { kind: string }).kind === "wait_ms") {
        const ms = (a as { ms?: unknown }).ms;
        if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
          return { ok: false, reason: "wait_ms requires a non-negative number 'ms'" };
        }
      }
    }
    if (invalidUiKeys.length > 0) {
      return {
        ok: false,
        reason: `uiKey(s) missing from registry: ${invalidUiKeys.join(", ")}`,
        invalidUiKeys,
      };
    }

    // Load + update cache. Bypass AI; this is a human edit.
    const cache = (await loadActionsCache(slug)) ?? {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      cases: {},
    };
    cache.cases[caseId] = { caseId, actions };
    cache.generatedAt = new Date().toISOString();
    await saveActionsCache(slug, cache);
    console.log(`[manual/save-actions] ${caseId}: ${actions.length} action(s) saved by QA edit`);
    return { ok: true };
  }

  /**
   * Batch re-translate all cases that are currently skipped (empty actions or
   * have skipReason). Useful after QA has discovered + verified more UI
   * elements — many cases that referenced previously-missing uiKeys can now
   * succeed. Cost = ~$0.02 × N skipped cases.
   */
  async retranslateAllSkipped(opts: { mode?: "skipped" | "all"; slugOverride?: string } = {}): Promise<{ ok: boolean; total?: number; succeeded?: number; stillSkipped?: number; reason?: string }> {
    const mode = opts.mode ?? "skipped";
    const slug = opts.slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required" };
    const catalog = await loadAiCatalog(slug);
    if (!catalog) return { ok: false, reason: "test-cases.json not found" };
    const reg = (this.gameSlug === slug && this.registry) ? this.registry : await uiRegistry.load(slug);
    if (!reg) return { ok: false, reason: "no registry available" };

    const cache = (await loadActionsCache(slug)) ?? {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      cases: {},
    };

    // mode=skipped → only cases with no actions or with skipReason
    // mode=all → ALL cases (force re-translate even runnable ones)
    const candidates = mode === "all"
      ? catalog.cases
      : catalog.cases.filter((c) => {
          const t = cache.cases[c.id];
          return !t || t.actions.length === 0 || t.skipReason;
        });

    let succeeded = 0;
    let stillSkipped = 0;
    console.log(`[manual/retranslate-all] ${candidates.length} candidates`);
    for (const c of candidates) {
      const translated = await translateCase({
        caseId: c.id,
        caseName: c.name,
        category: c.category,
        setup: c.setup_instructions ?? "",
        uiMap: reg,
        gameSpec: this.gameSpec ? {
          betLadder: this.gameSpec.betLadder,
          defaultBet: this.gameSpec.defaultBet,
          betMin: this.gameSpec.betMin,
          betMax: this.gameSpec.betMax,
        } : undefined,
        spinCount: c.spin_count,
        customAssertions: c.custom_assertions,
      });
      const { aiCalled: _ac, ...persistable } = translated;
      cache.cases[c.id] = persistable;
      if (translated.skipReason || translated.actions.length === 0) {
        stillSkipped++;
        console.log(`[manual/retranslate-all] ${c.id} still skipped: ${translated.skipReason ?? "no actions"}`);
      } else {
        succeeded++;
        console.log(`[manual/retranslate-all] ${c.id}${translated.aiCalled ? "" : " (no AI, empty setup)"} → ${translated.actions.length} actions`);
      }
    }
    cache.generatedAt = new Date().toISOString();
    await saveActionsCache(slug, cache);
    return { ok: true, total: candidates.length, succeeded, stillSkipped };
  }

  /**
   * Preview a single test case: execute its translated actions against the
   * Playwright browser (clicks at verified registry coords). User watches
   * Chrome window to confirm steps work, dashboard receives per-action trace.
   */
  async previewCase(
    caseId: string,
    opts: { ensureMain?: boolean } = {},
  ): Promise<{ ok: boolean; result?: CaseResult; reason?: string }> {
    if (!this.session || !this.gameSlug || !this.registry) return { ok: false, reason: "no active session" };
    const catalog = await loadAiCatalog(this.gameSlug);
    if (!catalog) return { ok: false, reason: "test-cases.json not found" };
    const tc = catalog.cases.find((c) => c.id === caseId);
    if (!tc) return { ok: false, reason: `case ${caseId} not in catalog` };
    const actionsCache = await loadActionsCache(this.gameSlug);
    const translated = actionsCache?.cases[caseId];
    if (!translated) return { ok: false, reason: "no translated actions for this case — run qa:cold to translate first" };

    // Pre-flight: every case must start on the MAIN game screen. Uses a
    // POLLING wait (not a one-shot check) so a leftover free-spin chain from a
    // PREVIOUS case (shared session state) is WAITED OUT — ensureMainScreen
    // flags FS-active + skips dismiss, and we poll until the chain finishes.
    // Dismissable popups (celebration / buy / paytable) are auto-recovered each
    // poll. Skip entirely when the caller already ensured main (dashboard
    // run-all loop does its own inter-case wait) via { ensureMain: false }.
    const PREFLIGHT_MAX_WAIT_MS = Number(process.env.QA_CASE_PREFLIGHT_MAX_WAIT_MS ?? 90_000);
    if (opts.ensureMain !== false) {
      const w = await this.waitForMainScreen({ maxWaitMs: PREFLIGHT_MAX_WAIT_MS });
      if (!w.onMain) {
        const reason = `not on main before case after ${(w.elapsedMs / 1000).toFixed(0)}s — ${w.reason ?? "could not reach main"}`;
        console.warn(`[preview-case] ${caseId} SKIP — ${reason}`);
        return {
          ok: true,
          result: {
            caseId: tc.id,
            name: tc.name,
            category: tc.category,
            severity: tc.severity,
            status: "skip",
            skipReason: reason,
            actionsExecuted: 0,
            assertions: [],
            spin: null,
            durationMs: 0,
          },
        };
      }
      if (w.recoveredCount > 0) console.log(`[preview-case] ${caseId} reached main before run (${w.polls} polls, ${w.recoveredCount} recoveries, ${(w.elapsedMs / 1000).toFixed(0)}s)`);
    }

    // Factory auto-loads parser kind + bet multiplier from registry. No more
    // ad-hoc setBetMultiplier injection — Phase 7.1B consolidation.
    const parser = await createParserForGame(this.gameSlug);

    // Auto-inject default allowed_interruptions for multi-spin cases (Part B
    // of state-machine runner overhaul). Slot games can randomly trigger
    // free spins / big wins / bonuses on ANY spin — treating that as a
    // failure-by-default is wrong. Any case that fires ≥2 spins should
    // tolerate these expected variations unless the catalog explicitly opts
    // out by setting `allowed_interruptions: []`.
    const spinActionCount = translated.actions.filter((a) => a.kind === "spin").length;
    const DEFAULT_INTERRUPTIONS = ["FREE_SPIN_TRIGGERED", "BIG_WIN_POPUP", "BONUS_POPUP"];
    let resolvedInterruptions = tc.allowed_interruptions;
    if (resolvedInterruptions === undefined && spinActionCount >= 2) {
      resolvedInterruptions = DEFAULT_INTERRUPTIONS;
      console.log(`[case-runner] auto-injected allowed_interruptions=${JSON.stringify(DEFAULT_INTERRUPTIONS)} for multi-spin case "${tc.id}" (${spinActionCount} spins)`);
    }

    const caseInput = {
      id: tc.id,
      name: tc.name,
      category: tc.category,
      severity: tc.severity,
      custom_assertions: tc.custom_assertions,
      minimum_evidence: tc.minimum_evidence,
      allowed_interruptions: resolvedInterruptions,
      on_feature_triggered: tc.on_feature_triggered,
      retry_policy: tc.retry_policy,
      actions: translated.actions,
      skipReason: translated.skipReason,
    };
    // Load the self-calibrated payout model (PP wlc_v games). Null/untrusted →
    // payoutModelCheck is a no-op, so cases run identically on uncalibrated games.
    const loadedPayoutModel = await payoutModel.load(this.gameSlug).catch(() => null);
    const ctx = {
      page: this.session.page,
      uiMap: this.registry,
      parser,
      priorBalance: this.lastBalance,
      // Live read so a multi-attempt retry loop sees the current balance, not
      // the snapshot taken when previewCase was first entered. The executor
      // uses this to seed balanceBefore for the first spin of each attempt.
      liveBalance: () => this.lastBalance,
      gameSlug: this.gameSlug,
      payoutModel: loadedPayoutModel,
    };

    // Retry loop. If the catalog declares a retry_policy, honor it. Otherwise
    // apply the DEFAULT "re-run on fail" behavior: a case that FAILS is re-run
    // exactly ONCE (maxRetries=1); only a persistent fail is recorded. A re-run
    // that passes is recorded as pass. ONLY a hard fail (status === "fail")
    // triggers a retry — INCONCLUSIVE / FAIL_LOW / FLAKY do NOT (retryWhen: []).
    const { runWithRetry } = await import("../step8-run-scenarios/case-retry-loop.js");
    const policy = tc.retry_policy ?? {
      maxRetries: Math.max(0, Math.min(5, Number(process.env.QA_CASE_FAIL_RETRIES ?? 1))),
      retryWhen: [],
      retryOnFailStatus: true,
    };
    // Re-ensure main between attempts (a failed run may have left a popup /
    // mid-feature state). The first attempt relies on the pre-flight above.
    let firstRun = true;
    const executeOnce = async (): Promise<CaseResult> => {
      if (!firstRun && opts.ensureMain !== false) {
        // A failed attempt may have left a popup OR triggered a free-spin chain
        // — poll-wait for main (FS-aware) before re-running.
        const w = await this.waitForMainScreen({ maxWaitMs: PREFLIGHT_MAX_WAIT_MS });
        if (!w.onMain) console.warn(`[preview-case] ${caseId} retry: still off-main after wait — running anyway`);
      }
      firstRun = false;
      return executeCase(ctx, caseInput);
    };
    const loop = await runWithRetry(executeOnce, policy);
    const result = loop.finalResult;
    if (loop.attempts > 1) {
      const history = loop.attemptHistory.map((a) => `#${a.attempt}=${a.outcome ?? a.status}`).join(", ");
      const recovered = result.status === "pass" && loop.attemptHistory[0]?.status === "fail";
      console.log(`[preview-case] ${caseId} ran ${loop.attempts} attempts: ${history}${recovered ? " → recovered (pass after retry)" : ""}`);
      result.warnings = [
        ...(result.warnings ?? []),
        `re-run ${loop.attempts - 1}× (first failed): ${history}`,
      ];
    }
    return { ok: true, result };
  }

  /**
   * Calibrate the per-game payout model (Layer 2 of payout verification).
   * Spins live at >= 2 bet levels, captures the server's per-combo win
   * breakdown (PP `wlc_v`) tagged with the ACTUAL coin from each response, then
   * derives + self-validates a PayoutModel (deterministic fit, AI assist only if
   * needed). Stores it to registry/payout-model.json. The model is only
   * `trusted` if it reproduces 100% of observed combos across >= 2 coin levels
   * AND agrees with the paytable — otherwise verification stays a no-op.
   *
   * Runs as its OWN flow (NOT through previewCase) so the retry loop / AI review
   * never interferes with capture.
   */
  async calibratePayoutModel(
    opts: { spinsPerLevel?: number } = {},
  ): Promise<{
    ok: boolean;
    reason?: string;
    trusted?: boolean;
    coinLevels?: number[];
    combosTotal?: number;
    combosMatched?: number;
    paytableAgreement?: boolean;
    symbolsModeled?: number;
    notes?: string[];
  }> {
    if (!this.session || !this.gameSlug || !this.registry) return { ok: false, reason: "no active session" };
    const page = this.session.page;
    const K = Math.max(8, Math.min(60, opts.spinsPerLevel ?? 25));

    // Side-channel capture: parse wlc_v + actual coin `c` from EVERY spin
    // response (initial + cascade frames) — independent of executeCase's own
    // dedup listener, and robust to set_bet not landing an exact coin.
    const combos: CalibrationCombo[] = [];
    const onResp = async (res: import("playwright").Response) => {
      try {
        const url = res.url();
        if (!/gameService|doSpin/i.test(url)) return;
        if (res.request().method() !== "POST") return;
        const body = await res.text();
        const parsed = pragmaticProvider.parseBody(body);
        if (!parsed) return;
        const coin = Number((parsed as Record<string, unknown>)["c"]);
        if (!Number.isFinite(coin) || coin <= 0) return;
        for (const wc of parseWlcV(parsed as Record<string, unknown>)) {
          combos.push({ ...wc, coin });
        }
      } catch {
        /* ignore individual response parse errors */
      }
    };
    page.on("response", onResp);

    try {
      // Pick two distinct bet levels (=> two distinct coins) from the ladder.
      const ladder = this.gameSpec?.betLadder ?? [];
      const higherIdx = ladder.length > 1 ? Math.min(Math.floor(ladder.length / 2) || 1, ladder.length - 1) : -1;
      const higherBet = higherIdx > 0 ? ladder[higherIdx]! : null;

      const actions: import("../step7-testcase-gen/case-action-translator.js").CaseAction[] = [
        { kind: "set_bet_to_min" },
        { kind: "wait_ms", ms: 800 },
      ];
      for (let i = 0; i < K; i++) { actions.push({ kind: "spin" }); actions.push({ kind: "wait_ms", ms: 2500 }); }
      if (higherBet != null) {
        actions.push({ kind: "set_bet_to_value", value: higherBet, reason: "calibration: second coin level" });
        actions.push({ kind: "wait_ms", ms: 800 });
        for (let i = 0; i < K; i++) { actions.push({ kind: "spin" }); actions.push({ kind: "wait_ms", ms: 2500 }); }
      }

      const parser = await createParserForGame(this.gameSlug);
      const ctx = {
        page,
        uiMap: this.registry,
        parser,
        priorBalance: this.lastBalance,
        liveBalance: () => this.lastBalance,
        gameSlug: this.gameSlug,
        payoutModel: null,
      };
      console.log(`[calibrate-payout] ${this.gameSlug}: spinning ${K}×${higherBet != null ? 2 : 1} level(s) to capture combos…`);
      await executeCase(ctx, {
        id: "payout-calibration",
        name: "Payout model calibration",
        category: "payout_correctness",
        severity: "minor",
        actions,
        allowed_interruptions: ["FREE_SPIN_TRIGGERED", "BIG_WIN_POPUP", "BONUS_POPUP"],
        on_feature_triggered: "handle_and_continue",
      });
    } finally {
      page.off("response", onResp);
    }

    const distinctCoins = [...new Set(combos.map((c) => c.coin))];
    console.log(`[calibrate-payout] ${this.gameSlug}: captured ${combos.length} combos across coins [${distinctCoins.join(", ")}]`);
    if (combos.length === 0) {
      return { ok: false, reason: "no winning combos captured — try more spins or a higher-volatility bet" };
    }

    const paytableData = await paytableStore.load(this.gameSlug).catch(() => null);
    const mech = await gameMechanics.load(this.gameSlug).catch(() => null);
    const model = await derivePayoutModel({
      combos,
      paytable: paytableData,
      mechanic: mech?.mechanic ?? "unknown",
    });
    await payoutModel.save(this.gameSlug, model);
    console.log(`[calibrate-payout] ${this.gameSlug}: model trusted=${model.trusted} reproduced=${model.calibration.combosMatched}/${model.calibration.combosTotal} coins=${model.calibration.coinLevels.length} paytableAgreement=${model.calibration.paytableAgreement}`);

    return {
      ok: true,
      trusted: model.trusted,
      coinLevels: model.calibration.coinLevels,
      combosTotal: model.calibration.combosTotal,
      combosMatched: model.calibration.combosMatched,
      paytableAgreement: model.calibration.paytableAgreement,
      symbolsModeled: Object.keys(model.symbolCurves).length,
      notes: model.notes,
    };
  }

  /**
   * Ship C — auto-mode preview. Run case → if outcome ∈ {FAIL_LOW,
   * INCONCLUSIVE} → heuristic-first AI Review. If heuristic ≥ 0.85 +
   * patch exists → auto-apply + rerun once. Skips AI fallback (avoids
   * cost) — if heuristic can't decide, just return the original result.
   *
   * Cap: 1 review + 1 patch + 1 rerun. NO further AI fallback or loop.
   * Loop variant: call autoRerunWithPatches() explicitly (user button).
   */
  async previewCaseAuto(
    caseId: string,
    opts: { ensureMain?: boolean } = {},
  ): Promise<{ ok: boolean; result?: CaseResult; reason?: string; autoActions?: string[] }> {
    const initial = await this.previewCase(caseId, opts);
    if (!initial.ok || !initial.result) return initial;

    const outcome = initial.result.outcome;
    const eligible = outcome === "FAIL_LOW" || outcome === "INCONCLUSIVE";
    if (!eligible) return initial;

    const autoLog: string[] = [`outcome=${outcome ?? initial.result.status} → auto-review triggered`];

    try {
      // Heuristic-only review (dryRun=true → no AI cost)
      const reviewResult = await this.reviewFailure(caseId, undefined, true, initial.result);
      if (!reviewResult.ok || !reviewResult.review) {
        autoLog.push("heuristic couldn't classify → giving up auto-mode");
        return { ...initial, autoActions: autoLog };
      }
      const review = reviewResult.review;
      autoLog.push(`heuristic: ${review.classification} (${(review.confidence * 100).toFixed(0)}%)`);

      if (review.confidence < 0.85 || !review.suggestedPatch) {
        autoLog.push("confidence < 0.85 or no patch → manual approval needed");
        return { ...initial, autoActions: autoLog };
      }

      // Auto-apply (gated by validator's 3 layers)
      const applied = await this.applyReviewPatch(caseId, undefined, review.suggestedPatch, review);
      if (!applied.ok) {
        autoLog.push(`auto-apply blocked: ${applied.reason}`);
        return { ...initial, autoActions: autoLog };
      }
      autoLog.push(`patch applied: ${review.suggestedPatch.file} (audit: ${applied.auditLogPath?.split("/").pop()})`);

      // One rerun (no further loop here — loop variant is autoRerunWithPatches)
      const rerun = await this.previewCase(caseId);
      if (!rerun.ok || !rerun.result) {
        autoLog.push(`rerun failed: ${rerun.reason}`);
        return { ...rerun, autoActions: autoLog };
      }
      autoLog.push(`rerun outcome: ${rerun.result.outcome ?? rerun.result.status}`);
      return { ok: true, result: rerun.result, autoActions: autoLog };
    } catch (err) {
      autoLog.push(`auto-mode error: ${err instanceof Error ? err.message : String(err)}`);
      return { ...initial, autoActions: autoLog };
    }
  }

  /**
   * Gap C — return historical stats (passRate, flakyScore, recent outcomes)
   * for a case so dashboard can show flakiness indicator. No-op if history
   * log doesn't exist (returns zeroes).
   */
  async caseStats(
    caseId: string,
    slugOverride?: string,
  ): Promise<{ ok: boolean; stats?: import("../step8-run-scenarios/history/index.js").CaseStats; reason?: string }> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required" };
    const { loadHistory, computeStats } = await import("../step8-run-scenarios/history/index.js");
    const history = await loadHistory(slug, caseId);
    return { ok: true, stats: computeStats(history) };
  }

  /**
   * Phase 7.5 — AI review a failed case. Loads last run result + compiles
   * knowledge → builds Evidence → calls classifier (heuristic-first, AI
   * fallback). Returns the classification + optional suggested patch.
   */
  async reviewFailure(
    caseId: string,
    slugOverride?: string,
    dryRun = false,
    /** Real CaseResult from the most recent run — dashboard passes via
     *  __caseResults[caseId]. When omitted, falls back to synthesized stub
     *  (legacy behavior). */
    realResult?: import("../step8-run-scenarios/case-executor.js").CaseResult,
  ): Promise<{ ok: boolean; review?: import("../step12-failure-review/index.js").ReviewResult; reason?: string }> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required" };
    const catalog = await loadAiCatalog(slug);
    if (!catalog) return { ok: false, reason: "test-cases.json not found" };
    const tc = catalog.cases.find((c) => c.id === caseId);
    if (!tc) return { ok: false, reason: `case ${caseId} not in catalog` };
    const actionsCache = await loadActionsCache(slug);
    const translated = actionsCache?.cases[caseId];

    const { compileKnowledge } = await import("../knowledge/compiler.js");
    const knowledge = await compileKnowledge(slug);
    if (knowledge.errors.length > 0) {
      return { ok: false, reason: `compiled-knowledge has errors: ${knowledge.errors.join("; ")}` };
    }

    // Use real result from dashboard if provided; else stub (back-compat).
    const caseResult = realResult ?? {
      caseId: tc.id,
      name: tc.name,
      category: tc.category,
      severity: tc.severity as "critical" | "major" | "minor",
      status: "fail" as const,
      actionsExecuted: translated?.actions.length ?? 0,
      assertions: [],
      spin: null,
      durationMs: 0,
      warnings: [],
    };

    const { buildEvidence, classifyFailure } = await import("../step12-failure-review/index.js");
    const evidence = buildEvidence({
      result: caseResult,
      knowledge,
      actionPlan: translated?.actions ?? [],
    });
    const review = await classifyFailure(evidence, { dryRun });
    if (!review) return { ok: false, reason: "heuristic could not classify; AI dryRun blocked" };
    return { ok: true, review };
  }

  /**
   * Phase 7.6 — validate + apply a SuggestedPatch produced by reviewFailure.
   * Writes to registry config file + appends audit log under patches/.
   */
  async applyReviewPatch(
    caseId: string,
    slugOverride: string | undefined,
    patch: import("../step12-failure-review/index.js").SuggestedPatch,
    review: import("../step12-failure-review/index.js").ReviewResult,
  ): Promise<{ ok: boolean; auditLogPath?: string; reason?: string; validation?: import("../step13-patch-apply/index.js").ValidationOutcome }> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) return { ok: false, reason: "gameSlug required" };
    const { validatePatch, applyPatch } = await import("../step13-patch-apply/index.js");
    const validation = await validatePatch(slug, patch);
    if (!validation.ok) {
      return { ok: false, reason: `patch failed validation: ${validation.errors.join("; ")}`, validation };
    }
    const applied = await applyPatch({ gameSlug: slug, caseId, review, patch, validation, dryRun: null });
    if (!applied.ok) {
      return { ok: false, reason: `apply failed: ${applied.errors.join("; ")}`, validation };
    }
    // Reload registry so subsequent runs see the patch
    const refreshed = await uiRegistry.load(slug);
    if (refreshed) this.registry = refreshed;
    return { ok: true, auditLogPath: applied.auditLogPath, validation };
  }

  /**
   * Phase 8 item 3 — Auto-rerun loop. Apply patch → rerun case → if still
   * fail → AI re-review → apply next patch → loop max 3 times. Returns
   * RerunResult with status ∈ {"pass", "fail", "escalated"} + log array
   * for dashboard display.
   */
  async autoRerunWithPatches(
    caseId: string,
    slugOverride: string | undefined,
    initialPatch: import("../step12-failure-review/index.js").SuggestedPatch,
    initialReview: import("../step12-failure-review/index.js").ReviewResult,
  ): Promise<import("../step13-patch-apply/types.js").RerunResult> {
    const slug = slugOverride ?? this.gameSlug;
    if (!slug) {
      return { status: "escalated", attemptsUsed: 0, patchesApplied: 0, log: ["gameSlug required"] };
    }
    const { rerunWithPatches } = await import("../step13-patch-apply/rerun-orchestrator.js");
    return rerunWithPatches({
      caseId,
      gameSlug: slug,
      initialPatch,
      initialReview,
      callbacks: {
        applyPatch: async (patch, review) => {
          const r = await this.applyReviewPatch(caseId, slug, patch, review);
          return { ok: r.ok, reason: r.reason };
        },
        rerunCase: async () => {
          const r = await this.previewCase(caseId);
          return {
            ok: r.ok,
            result: r.result ? {
              status: r.result.status,
              outcome: r.result.outcome,
            } : undefined,
            reason: r.reason,
          };
        },
        reReview: async () => {
          const r = await this.reviewFailure(caseId, slug, false);
          return { ok: r.ok, review: r.review, reason: r.reason };
        },
      },
    });
  }

  /**
   * Attach a page-level response listener that watches for `balance=N` in any
   * game-service response (doInit, doSpin, reloadBalance, etc.) and updates
   * `lastBalance`. Called once at session start; persists across reloads
   * because the BrowserContext is shared. Fail-safe: errors swallowed.
   */
  private attachBalanceTracker(): void {
    if (!this.session) return;
    this.session.page.on("response", async (res) => {
      try {
        const url = res.url();
        // PP game service + reload-balance endpoints both carry balance fields.
        if (!/gameService|reloadBalance|gs2c/i.test(url)) return;
        const body = await res.text().catch(() => "");
        if (!body) return;
        // Prefer balance_cash if present (more authoritative on PP) else fall back to balance
        const cashMatch = body.match(/(?:^|&)balance_cash=([\d.]+)/);
        const balMatch = body.match(/(?:^|&)balance=([\d.]+)/);
        const captured = cashMatch ? Number(cashMatch[1]) : balMatch ? Number(balMatch[1]) : null;
        const previous = this.lastBalance;
        if (captured !== null && Number.isFinite(captured)) {
          if (this.lastBalance !== captured) {
            console.log(`[manual/balance] ${this.lastBalance ?? "—"} → ${captured} (from ${new URL(url).pathname})`);
          }
          this.lastBalance = captured;
        }
        // Capture game spec from doInit (or first doSpin) — bet ladder etc.
        if (!this.gameSpec) this.tryCaptureGameSpec(body);

        // Derive game-mechanics on first spin pair (where balance actually
        // dropped). Only run once per game slug — once saved, subsequent
        // sessions load from registry. Detect from request fields + observed
        // balance delta + response win value.
        if (
          this.gameSlug &&
          captured !== null &&
          previous !== null &&
          previous > captured &&    // balance dropped → this was a real bet
          !this.gameMechanicsCached
        ) {
          await this.tryDeriveGameMechanics(res, body, previous, captured);
        }
      } catch {
        // ignore
      }
    });
  }

  /**
   * On observing a real bet deduction, derive { mechanic, betMultiplier }
   * from the request fields + balance delta, save to registry, and inject
   * into the active parser (case-executor reads from registry at start, but
   * we update mid-session for newly-detected games).
   */
  private async tryDeriveGameMechanics(
    res: import("playwright").Response,
    body: string,
    prevBalance: number,
    newBalance: number,
  ): Promise<void> {
    if (!this.gameSlug) return;
    // If registry already has mechanics, mark cached + skip.
    if (this.gameMechanicsCached === undefined) {
      const existing = await gameMechanics.load(this.gameSlug);
      if (existing) {
        this.gameMechanicsCached = existing;
        return;
      }
    }
    if (this.gameMechanicsCached) return;

    const rawReq = res.request().postData();
    if (!rawReq) return;
    const parsedReq = pragmaticProvider.parseBody(rawReq);
    if (!parsedReq) return;
    // Pull win from response body (PP `tw` field). Default to 0 if absent.
    const twMatch = body.match(/(?:^|&)tw=([\d.]+)/);
    const win = twMatch ? Number(twMatch[1]) : 0;
    const derived = deriveGameMechanics({
      parsedRequest: parsedReq,
      balanceBefore: prevBalance,
      balanceAfter: newBalance,
      win,
      rawRequest: rawReq,
    });
    if (!derived) return;
    this.gameMechanicsCached = derived;
    await gameMechanics.save(this.gameSlug, derived);
    console.log(`[manual/game-mechanics] derived for ${this.gameSlug}: mechanic=${derived.mechanic} betMultiplier=${derived.betMultiplier} (l=${derived.waysOrLines}, c=${derived.evidence?.coin}, deducted=${derived.evidence?.deductedFromBalance})`);
  }

  private tryCaptureGameSpec(body: string): void {
    const scMatch = body.match(/(?:^|&)sc=([\d.,]+)/);
    const lMatch = body.match(/(?:^|&)l=(\d+)/);
    const defcMatch = body.match(/(?:^|&)defc=([\d.]+)/);
    const blsMatch = body.match(/(?:^|&)bls=([\d.,]+)/);
    // PP do_init also carries `defbl` (default bet level, 1-indexed into bls).
    // Without applying it, defaultBet only reflects coin×lines and ignores
    // the Ante Bet / Bonus Bet multiplier the server actually bills, so
    // catalog "default-bet-equals-X" assertions diverge from real spins
    // (e.g. UI 7 vs API 13.30 for 1.9× ante).
    const defblMatch = body.match(/(?:^|&)defbl=(\d+)/);
    const minMatch = body.match(/(?:^|&)total_bet_min=([\d.]+)/);
    const maxMatch = body.match(/(?:^|&)total_bet_max=([\d.]+)/);
    if (!scMatch || !lMatch) return;
    const coinValues = scMatch[1]!.split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
    const lines = Number(lMatch[1]);
    const defaultCoin = defcMatch ? Number(defcMatch[1]) : coinValues[0]!;
    const betLevels = blsMatch ? blsMatch[1]!.split(",").map(Number).filter(Number.isFinite) : [];
    const defaultBetLevelIdx = defblMatch ? Math.max(1, Number(defblMatch[1])) - 1 : 0;
    const defaultBetLevel = betLevels.length > 0 ? (betLevels[defaultBetLevelIdx] ?? betLevels[0] ?? 1) : 1;
    const betMin = minMatch ? Number(minMatch[1]) : coinValues[0]! * lines * (betLevels[0] ?? 1);
    const betMax = maxMatch
      ? Number(maxMatch[1])
      : coinValues[coinValues.length - 1]! * lines * (betLevels[betLevels.length - 1] ?? 1);
    // betLadder: every achievable coin×lines×level. Sorted + deduped so the
    // translator can compute step distance for set_bet_to_value. Round to 2
    // decimals to avoid floating-noise duplicates (e.g. 13.3 vs 13.299...).
    const ladderSet = new Set<number>();
    const levelsForLadder = betLevels.length > 0 ? betLevels : [1];
    for (const c of coinValues) {
      for (const lvl of levelsForLadder) {
        ladderSet.add(Math.round(c * lines * lvl * 100) / 100);
      }
    }
    const betLadder = Array.from(ladderSet).sort((a, b) => a - b);
    this.gameSpec = {
      coinValues,
      lines,
      defaultCoin,
      betLevels,
      betMin,
      betMax,
      defaultBet: Math.round(defaultCoin * lines * defaultBetLevel * 100) / 100,
      betLadder,
    };
    console.log(`[manual/spec] captured: ladder=${this.gameSpec.betLadder.slice(0, 5).join(",")}…(${this.gameSpec.betLadder.length}) default=${this.gameSpec.defaultBet} (coin=${defaultCoin}×lines=${lines}×bl=${defaultBetLevel}) min=${betMin} max=${betMax}`);
  }

  /**
   * Hybrid wait between batch cases. Combines:
   *   1. Fixed minimum delay (animation start has time to begin)
   *   2. Pixel-diff loop: crop around spinButton baseline vs live every 500ms.
   *      When N consecutive samples match baseline (within threshold) → settled.
   *   3. Hard cap (default 45s) for safety (free spins / cascade chain).
   *
   * Returns settled=true when stable confirmed, false if cap reached.
   */
  async waitForStable(opts: {
    uiKey?: string;
    minDelayMs?: number;
    maxMs?: number;
    pollMs?: number;
    stableSamples?: number;
    diffThreshold?: number;
  } = {}): Promise<{ ok: boolean; settled: boolean; durationMs: number; samples: number; reason?: string }> {
    if (!this.session || !this.gameSlug || !this.registry) return { ok: false, settled: false, durationMs: 0, samples: 0, reason: "no active session" };
    const uiKey = opts.uiKey ?? "spinButton";
    const el = this.registry[uiKey];
    if (!el?.baselineScreenshot) {
      // No baseline to diff against → fall back to fixed wait
      const fallback = opts.minDelayMs ?? 3000;
      await this.session.page.waitForTimeout(fallback);
      return { ok: true, settled: true, durationMs: fallback, samples: 0, reason: "no baseline; used fixed delay" };
    }
    const baselinePath = path.join(dirForGame(this.gameSlug), "baselines", el.baselineScreenshot);
    let baseline: Buffer;
    try {
      baseline = await readFile(baselinePath);
    } catch {
      const fallback = opts.minDelayMs ?? 3000;
      await this.session.page.waitForTimeout(fallback);
      return { ok: true, settled: true, durationMs: fallback, samples: 0, reason: "baseline unreadable; used fixed delay" };
    }

    const minDelay = opts.minDelayMs ?? 1500;
    const maxMs = opts.maxMs ?? 45_000;
    const pollMs = opts.pollMs ?? 500;
    const stableSamples = opts.stableSamples ?? 2;
    const diffThreshold = opts.diffThreshold ?? 0.05;

    const start = Date.now();
    await this.session.page.waitForTimeout(minDelay);

    const region = regionAround(el.x, el.y, 80, 80);
    let consecutiveStable = 0;
    let samples = 0;
    while (Date.now() - start < maxMs) {
      try {
        const { ratio, changed } = await diffVsBaseline(this.session.page, baseline, region, {
          pixelThreshold: 0.1,
          changeThreshold: diffThreshold,
        });
        samples++;
        if (!changed) consecutiveStable++;
        else consecutiveStable = 0;
        if (consecutiveStable >= stableSamples) {
          return { ok: true, settled: true, durationMs: Date.now() - start, samples };
        }
        void ratio;
      } catch {
        // Diff failure (size mismatch, etc.) — keep polling
      }
      await this.session.page.waitForTimeout(pollMs);
    }
    return { ok: true, settled: false, durationMs: Date.now() - start, samples, reason: `timed out after ${maxMs}ms` };
  }

  async stop(): Promise<void> {
    if (this.session) {
      await closeBrowser(this.session);
    }
    this.session = null;
    this.gameSlug = null;
    this.gameUrl = null;
    this.startedAt = null;
    this.registry = null;
    this.verifyState = {};
    this.lastBalance = null;
  }
}

export const manualSession = new ManualSessionManager();

export type RegisteredGame = {
  gameSlug: string;
  gameUrl: string;
  /** Friendly game name from provider-cache (e.g. "Mahjong Wins 2"). Matches
   *  the name shown in RUN SUMMARY. Undefined when provider-cache missing. */
  gameName?: string;
  /** Provider label from provider-cache (e.g. "Pragmatic" / "Generic"). */
  provider?: string;
  createdAt: string;
  lastValidatedAt?: string;
  elementCount: number;
  verifiedCount: number;
  pendingCount: number;
  rejectedCount: number;
};

/**
 * Update gameUrl in _meta.json without touching the registry. Use case: token
 * in URL expired → change token, registry (UI coords + sub-states) still valid.
 * If session is currently active on this slug, also navigates the browser to
 * the new URL.
 */
export async function updateGameUrl(gameSlug: string, newUrl: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    new URL(newUrl);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  const m = await meta.load(gameSlug);
  if (!m) return { ok: false, reason: `No registry for ${gameSlug}` };
  await meta.save(gameSlug, { ...m, gameUrl: newUrl });

  // If active session targets this slug, navigate page to new URL so QA can
  // verify the existing registry still maps correctly under the new token.
  if (manualSession.status().active && manualSession.status().gameSlug === gameSlug) {
    await manualSession.navigateTo(newUrl);
  }
  return { ok: true };
}

/**
 * Delete a game and ALL related fixtures: registry folder, pre-game record,
 * provider spec, recorded scenarios, and statistical debug dumps. Stops the
 * active session first if it targets this slug. Irreversible.
 */
export async function deleteGame(gameSlug: string): Promise<{ ok: boolean; removed: string[]; reason?: string }> {
  // Path-traversal guard — slug must be a plain folder name.
  if (!/^[a-zA-Z0-9_-]+$/.test(gameSlug)) {
    return { ok: false, removed: [], reason: `invalid slug "${gameSlug}"` };
  }
  // If the active session is on this game, stop it first so the browser +
  // file handles are released before we delete.
  if (manualSession.status().active && manualSession.status().gameSlug === gameSlug) {
    await manualSession.stop().catch(() => {});
  }

  const removed: string[] = [];
  const rmPath = async (p: string) => {
    try {
      await rm(p, { recursive: true, force: true });
      removed.push(p);
    } catch {
      // ignore — path may not exist
    }
  };

  // 1. Main registry folder (registry + case-evidence + history + debug-*).
  await rmPath(dirForGame(gameSlug));
  // 2. Single-file per-slug fixtures.
  await rmPath(path.join("fixtures", "pre-game", `${gameSlug}.json`));
  // 3. Per-slug folders elsewhere.
  await rmPath(path.join("fixtures", "specs", gameSlug));
  await rmPath(path.join("fixtures", "scenarios", gameSlug));
  // 4. Timestamped statistical debug dumps: `<slug>-<ISO>-debug`.
  try {
    const statDir = path.join("fixtures", "statistical");
    const entries = await readdir(statDir);
    for (const e of entries) {
      if (e === gameSlug || e.startsWith(`${gameSlug}-`)) {
        await rmPath(path.join(statDir, e));
      }
    }
  } catch {
    // statistical dir may not exist
  }

  if (removed.length === 0) {
    return { ok: false, removed, reason: `nothing found for "${gameSlug}"` };
  }
  return { ok: true, removed };
}

/**
 * List all games that have a registry on disk. Used by dashboard to show
 * "previously registered" games so QA can resume without re-discovery.
 */
export async function listRegisteredGames(): Promise<RegisteredGame[]> {
  const registryRoot = "fixtures/registry";
  let dirs: string[] = [];
  try {
    dirs = await readdir(registryRoot);
  } catch {
    return [];
  }
  const out: RegisteredGame[] = [];
  for (const slug of dirs) {
    try {
      const m = await meta.load(slug);
      const reg = await uiRegistry.load(slug);
      if (!m || !reg) continue;
      let verified = 0, pending = 0, rejected = 0;
      for (const el of Object.values(reg)) {
        if (!el) continue;
        const s = el.status ?? "pending";
        if (s === "verified") verified++;
        else if (s === "rejected") rejected++;
        else pending++;
      }
      // Friendly name + provider from provider-cache (same source as RUN
      // SUMMARY). Missing cache → leave undefined; dashboard falls back to slug.
      const pc = await providerCache.load(slug).catch(() => null);
      out.push({
        gameSlug: slug,
        gameUrl: m.gameUrl,
        gameName: pc?.gameName,
        provider: pc?.provider,
        createdAt: m.createdAt,
        lastValidatedAt: m.lastValidatedAt,
        elementCount: Object.keys(reg).length,
        verifiedCount: verified,
        pendingCount: pending,
        rejectedCount: rejected,
      });
    } catch {
      // skip games with corrupt registry
    }
  }
  // Most recent first
  out.sort((a, b) => (b.lastValidatedAt ?? b.createdAt).localeCompare(a.lastValidatedAt ?? a.createdAt));
  return out;
}
