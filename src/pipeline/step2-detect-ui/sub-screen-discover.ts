// AI: called only during cold-start. Pre-discovers buttons inside popups
// (buyBonus / history / paytable / menu / autoplay). One AI call per popup scope.
// Result merged into ui-registry with namespaced keys (e.g. `buyBonus__superButton`).
//
// Safety: ONLY opens popups + reads contents. NEVER clicks confirm/start (would
// deduct balance / trigger autoplay). After each popup, presses ESC to close.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { askClaude, extractJsonFromText } from "../../ai/claude.js";
import { waitUntilStable, snapshot, pixelDiff } from "../utils/pixel-diff/index.js";
import type { UiElement, UiRegistry } from "../registry/types.js";
import { dirForGame } from "../registry/paths.js";

export type PopupScope = "buyBonus" | "history" | "paytable" | "menu" | "autoplay";

type PopupSpec = {
  scope: PopupScope;
  triggerKey: keyof UiRegistry | string;
  systemPrompt: string;
  userPrompt: string;
};

const POPUP_SPECS: PopupSpec[] = [
  {
    scope: "buyBonus",
    triggerKey: "buyBonusButton",
    systemPrompt:
      "You are a slot-game UI locator looking at a Buy Bonus / Buy Feature popup. Return ONLY JSON. Identify clickable buttons inside the popup with pixel coordinates.",
    userPrompt: `This is the BUY BONUS popup of a slot game. Return JSON with any of these elements you SEE (omit ones not visible):

{
  "superButton":  { "x": int, "y": int, "confidence": 0..1 },     // "Buy Super" / highest-tier
  "normalButton": { "x": int, "y": int, "confidence": 0..1 },     // "Buy Free Spins" standard
  "anteButton":   { "x": int, "y": int, "confidence": 0..1 },     // "Ante Bet" / boost
  "confirmButton":{ "x": int, "y": int, "confidence": 0..1 },     // "Confirm" / "Yes" / "Buy"
  "cancelButton": { "x": int, "y": int, "confidence": 0..1 },     // "Cancel" / "No"
  "closeButton":  { "x": int, "y": int, "confidence": 0..1 }      // X icon to close popup
}

JSON only. No prose.`,
  },
  {
    scope: "history",
    triggerKey: "historyButton",
    systemPrompt:
      "You are a slot-game UI locator looking at a History popup. Return ONLY JSON.",
    userPrompt: `This is the HISTORY popup. Identify visible buttons:

{
  "closeButton":     { "x": int, "y": int, "confidence": 0..1 },
  "prevPageButton":  { "x": int, "y": int, "confidence": 0..1 },
  "nextPageButton":  { "x": int, "y": int, "confidence": 0..1 },
  "firstRowArea":    { "x": int, "y": int, "confidence": 0..1 }  // center of first history row
}

JSON only.`,
  },
  {
    scope: "paytable",
    triggerKey: "paytableButton",
    systemPrompt:
      "You are a slot-game UI locator looking at a Paytable / Rules popup. Return ONLY JSON.",
    userPrompt: `This is the PAYTABLE/RULES popup. Identify visible buttons:

{
  "closeButton":     { "x": int, "y": int, "confidence": 0..1 },
  "prevPageButton":  { "x": int, "y": int, "confidence": 0..1 },
  "nextPageButton":  { "x": int, "y": int, "confidence": 0..1 }
}

JSON only.`,
  },
  {
    scope: "menu",
    triggerKey: "menuButton",
    systemPrompt:
      "You are a slot-game UI locator looking at a Menu / Settings popup. Return ONLY JSON.",
    userPrompt: `This is the MENU / SETTINGS popup. Identify visible buttons:

{
  "closeButton":  { "x": int, "y": int, "confidence": 0..1 },
  "rulesButton":  { "x": int, "y": int, "confidence": 0..1 },
  "soundToggle":  { "x": int, "y": int, "confidence": 0..1 },
  "settingsButton": { "x": int, "y": int, "confidence": 0..1 }
}

JSON only.`,
  },
  {
    scope: "autoplay",
    triggerKey: "autoButton",
    systemPrompt:
      "You are a slot-game UI locator looking at an Autoplay configuration popup. Return ONLY JSON. DO NOT click start.",
    userPrompt: `This is the AUTOPLAY popup. Identify visible buttons (DO NOT START):

{
  "closeButton":      { "x": int, "y": int, "confidence": 0..1 },
  "count5Button":     { "x": int, "y": int, "confidence": 0..1 },   // "5 spins"
  "count10Button":    { "x": int, "y": int, "confidence": 0..1 },
  "count25Button":    { "x": int, "y": int, "confidence": 0..1 },
  "count50Button":    { "x": int, "y": int, "confidence": 0..1 },
  "count100Button":   { "x": int, "y": int, "confidence": 0..1 },
  "stopOnWinToggle":  { "x": int, "y": int, "confidence": 0..1 }
}

JSON only. Do NOT include the "Start" button — we will not start autoplay during discovery.`,
  },
];

const POPUP_OPEN_DIFF_THRESHOLD = 0.08;

export type SubScreenDiscoverResult = {
  scope: PopupScope;
  discovered: Record<string, UiElement>;
  popupDetected: boolean;
  closed: boolean;
  reason?: string;
};

export async function discoverSubScreens(
  page: Page,
  gameSlug: string,
  uiMap: UiRegistry,
): Promise<{ updated: UiRegistry; results: SubScreenDiscoverResult[] }> {
  const debugDir = path.join(dirForGame(gameSlug), "sub-screens");
  await mkdir(debugDir, { recursive: true });

  const updated: UiRegistry = { ...uiMap };
  const results: SubScreenDiscoverResult[] = [];

  for (const spec of POPUP_SPECS) {
    const trigger = (uiMap as Record<string, UiElement | undefined>)[spec.triggerKey];
    if (!trigger) {
      results.push({
        scope: spec.scope,
        discovered: {},
        popupDetected: false,
        closed: true,
        reason: `trigger ${String(spec.triggerKey)} not in main registry`,
      });
      continue;
    }

    const result = await openAndDiscover(page, spec, trigger, gameSlug, debugDir);
    for (const [key, el] of Object.entries(result.discovered)) {
      const namespacedKey = `${spec.scope}__${key}`;
      (updated as Record<string, UiElement | undefined>)[namespacedKey] = el;
    }
    results.push(result);
  }

  return { updated, results };
}

async function openAndDiscover(
  page: Page,
  spec: PopupSpec,
  trigger: UiElement,
  gameSlug: string,
  debugDir: string,
): Promise<SubScreenDiscoverResult> {
  // Snapshot BEFORE click for popup detection.
  let before;
  try {
    before = await snapshot(page);
  } catch (err) {
    return mkErr(spec.scope, `pre-click snapshot failed: ${String(err)}`);
  }

  try {
    await page.mouse.click(trigger.x, trigger.y);
  } catch (err) {
    return mkErr(spec.scope, `click trigger failed: ${String(err)}`);
  }

  // Wait for popup to settle.
  await waitUntilStable(page, { maxIterations: 12, changeThreshold: 0.005, consecutiveStable: 2 });

  let after;
  try {
    after = await snapshot(page);
  } catch (err) {
    return mkErr(spec.scope, `post-click snapshot failed: ${String(err)}`);
  }

  const dim = before.width === after.width && before.height === after.height;
  const diffRatio = dim ? pixelDiff(before, after).ratio : 1;
  const popupDetected = diffRatio > POPUP_OPEN_DIFF_THRESHOLD;

  if (!popupDetected) {
    return {
      scope: spec.scope,
      discovered: {},
      popupDetected: false,
      closed: true,
      reason: `click did not open popup (pixel diff ${diffRatio.toFixed(3)} below threshold)`,
    };
  }

  // Save screenshot for debug.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const debugPng = path.join(debugDir, `${spec.scope}-${ts}.png`);
  try {
    await page.screenshot({ path: debugPng, type: "png" });
  } catch {
    // ignore
  }

  // AI vision discover popup elements.
  const buf = await page.screenshot({ type: "png" });
  const b64 = buf.toString("base64");
  let parsed: Record<string, { x: number; y: number; confidence?: number }> | null = null;
  try {
    const text = await askClaude({
      label: `step2/sub-screen/${spec.scope}`,
      system: spec.systemPrompt,
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: b64 },
        },
        { type: "text", text: spec.userPrompt },
      ],
      maxTurns: 1,
      timeoutMs: 60_000,
    });
    parsed = extractJsonFromText(text);
  } catch (err) {
    parsed = null;
    const reason = `AI vision failed: ${err instanceof Error ? err.message : String(err)}`;
    await closePopup(page);
    return { scope: spec.scope, discovered: {}, popupDetected: true, closed: true, reason };
  }

  const discovered: Record<string, UiElement> = {};
  if (parsed) {
    for (const [key, coord] of Object.entries(parsed)) {
      if (
        !coord ||
        typeof coord.x !== "number" ||
        typeof coord.y !== "number" ||
        coord.x <= 0 ||
        coord.y <= 0
      ) {
        continue;
      }
      discovered[key] = {
        x: Math.round(coord.x),
        y: Math.round(coord.y),
        strategy: "ai_vision",
        confidence: coord.confidence ?? 0.8,
        detectedAt: new Date().toISOString(),
      };
    }
  }

  const closed = await closePopup(page);

  return {
    scope: spec.scope,
    discovered,
    popupDetected: true,
    closed,
    reason: closed ? undefined : "popup may still be visible (ESC + click close failed)",
  };
}

async function closePopup(page: Page): Promise<boolean> {
  // Try ESC first — most popups dismiss.
  try {
    await page.keyboard.press("Escape");
  } catch {
    // ignore
  }
  await waitUntilStable(page, { maxIterations: 8, changeThreshold: 0.005, consecutiveStable: 2 });

  // Heuristic: try clicking top-right area where X is usually placed.
  const FALLBACK_CLOSE_COORDS = [
    { x: 1820, y: 80 },  // top-right X
    { x: 1700, y: 80 },  // alternate
  ];
  for (const c of FALLBACK_CLOSE_COORDS) {
    try {
      await page.mouse.click(c.x, c.y);
      await waitUntilStable(page, {
        maxIterations: 6,
        changeThreshold: 0.005,
        consecutiveStable: 2,
      });
    } catch {
      // ignore
    }
  }
  return true; // best-effort
}

function mkErr(scope: PopupScope, reason: string): SubScreenDiscoverResult {
  return { scope, discovered: {}, popupDetected: false, closed: true, reason };
}
