// Runtime self-validation for AI-discovered UI elements. Clicks the proposed
// coord and observes a domain-specific signal (network response / popup OCR)
// to confirm the click actually hits the intended target. Without this gate, an
// AI-discovered element with a drifted bbox silently fails every case that uses
// it; with it, drift is auto-corrected by offset retries OR the element stays
// "pending" for QA review — never silently wrong.
//
// Probes are deterministic (no AI calls): take a screenshot or network event
// AFTER the click and check for a hard-coded signature. Each probe must leave
// the game on the MAIN screen so subsequent probes start clean.

import type { Page } from "playwright";
import type { UiElement } from "../registry/types.js";
import {
  detectAnyPopup,
  dismissPopupsLoop,
  ocrRegion,
  parseNumericFromOcr,
  SUBSTATE_POPUP_KEYWORDS,
} from "../utils/ocr-popup.js";

export type ProbeKind =
  | "spinButton"
  | "betPlus"
  | "betMinus"
  | "menuButton"
  | "paytableButton"
  | "historyButton"
  | "buyBonusButton"
  | "autoButton"
  | "genericToggle";

export type ProbeResult = {
  /** true = signal observed → element verified. */
  ok: boolean;
  /** false = uiKey wasn't probeable (no probe defined for its kind). */
  probed: boolean;
  kind?: ProbeKind;
  /** Short tag describing the signal that confirmed (e.g. "spinResponse",
   *  "popup:paytable"). Stored on the element so QA can audit later. */
  signal?: string;
  /** Total click attempts (1 = first click worked; up to MAX_OFFSETS). */
  attempts: number;
  /** Coord that actually produced the signal (after offset retry). */
  finalCoord?: { x: number; y: number };
  reason?: string;
};

/**
 * Probe a sub-state (popup-namespaced) element via pixel diff. Assumes the
 * popup containing this element is ALREADY OPEN — the caller (manual-session
 * `probePendingElements`) is responsible for navigating to the popup before
 * calling this.
 *
 * Signal: ≥2% of pixels in a full-screen comparison change between
 * "before-click" and "after-click ± 1.5s" snapshots. Catches:
 *   - sub-popup opens (large area change)
 *   - toggle highlight / state flip (small region but well over 2%)
 *   - page transitions (paytable next page, settings tab change)
 *   - dismissive clicks (close button → main screen → very large diff)
 *
 * All of those count as "the element is live and clickable". For probe
 * verification we don't need to know WHICH effect happened, only that
 * SOMETHING happened. Threshold 2% chosen to clear typical ambient
 * animation (~0.5-1%) while catching small UI changes (digit flip, single
 * toggle, etc.) reliably.
 *
 * The caller is also responsible for dismissing whatever state the click
 * left behind before the next probe — this function never recovers state
 * itself, so consecutive probes inside the same popup remain deterministic.
 */
export async function probeSubStateElement(
  page: Page,
  el: UiElement,
): Promise<ProbeResult> {
  if (!Number.isFinite(el.x) || !Number.isFinite(el.y)) {
    return { ok: false, probed: true, attempts: 0, reason: "invalid coord" };
  }
  for (let i = 0; i < OFFSETS.length; i++) {
    const off = OFFSETS[i]!;
    const x = Math.round(el.x + off.dx);
    const y = Math.round(el.y + off.dy);
    let before: Buffer | null = null;
    try {
      before = await page.screenshot({ type: "png" });
    } catch {}
    try {
      await page.mouse.click(x, y);
    } catch {
      continue;
    }
    // Wait for click response. Most popup-internal effects settle in 1-1.5s
    // (toggle highlights ~100ms, sub-popup opens ~500-1000ms).
    await page.waitForTimeout(1500);
    let after: Buffer | null = null;
    try {
      after = await page.screenshot({ type: "png" });
    } catch {}
    if (!before || !after) continue;
    let diff = 0;
    try {
      diff = await bufferPixelDiff(before, after);
    } catch {}
    if (diff > 0.02) {
      return {
        ok: true,
        probed: true,
        signal: `subStatePixelDiff:${(diff * 100).toFixed(1)}%`,
        attempts: i + 1,
        finalCoord: { x, y },
      };
    }
  }
  return { ok: false, probed: true, attempts: OFFSETS.length, reason: "no pixel change after offset retries" };
}

/** Map a uiKey to its probe kind, or null when unprobeable in P1. */
export function inferProbeKind(uiKey: string): ProbeKind | null {
  switch (uiKey) {
    case "spinButton": return "spinButton";
    case "betPlus": return "betPlus";
    case "betMinus": return "betMinus";
    case "menuButton": return "menuButton";
    case "paytableButton": return "paytableButton";
    case "historyButton": return "historyButton";
    case "buyBonusButton": return "buyBonusButton";
    case "autoButton": return "autoButton";
  }
  // Generic patterns for top-level auto-added extras (sound_toggle,
  // special_bets_toggle, ambient_toggle, …). These have no dedicated probe
  // kind but are still probeable via a local pixel-diff: a toggle's icon
  // flips on click, producing a small but distinct change near the click
  // coord. The probe also clicks again at the end to restore the toggle's
  // pre-probe state so we don't leak side-effects (e.g. leaving ante bet
  // enabled, which would change the next spin's cost).
  if (!uiKey.includes("__") && /[_-]?[Tt]oggle$/i.test(uiKey)) {
    return "genericToggle";
  }
  return null;
}

/** Offset retry pattern — first center, then cross ±5/±10 to absorb the
 *  ~5-15px drift typical of AI-vision bboxes on canvas-rendered slots. */
const OFFSETS: ReadonlyArray<{ dx: number; dy: number }> = [
  { dx: 0, dy: 0 },
  { dx: -8, dy: 0 }, { dx: 8, dy: 0 }, { dx: 0, dy: -8 }, { dx: 0, dy: 8 },
];

/**
 * Fraction-of-pixels diff between two PNG buffers of equal dimensions.
 * Sum-of-channel-deltas > 30 (≈10/channel avg) counts a pixel as "different".
 * Returns 0..1; mismatched dims → 1 (everything different). Used by the bet±
 * probe to detect a bet-display change when there's no saveSettings.do
 * network signal AND OCR can't read the digit font cleanly.
 */
async function bufferPixelDiff(a: Buffer, b: Buffer): Promise<number> {
  const { PNG } = await import("pngjs");
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return 1;
  const total = pa.width * pa.height;
  if (total === 0) return 0;
  let diff = 0;
  for (let p = 0; p < total; p++) {
    const idx = p * 4;
    const dr = Math.abs(pa.data[idx]! - pb.data[idx]!);
    const dg = Math.abs(pa.data[idx + 1]! - pb.data[idx + 1]!);
    const db = Math.abs(pa.data[idx + 2]! - pb.data[idx + 2]!);
    if (dr + dg + db > 30) diff++;
  }
  return diff / total;
}

/** Expected popup keyword(s) per "open popup" kind. Defined inline so the
 *  probe is a single deterministic check; uses the same SUBSTATE_POPUP_KEYWORDS
 *  list the rest of the engine trusts (no separate vocab to drift). */
function expectedKeywordsFor(kind: ProbeKind): string[] {
  // Tightened 2026-05-30: keywords are SPECIFIC to each kind to avoid
  // cross-key false confirms. Each list MUST contain at least one phrase that
  // only appears in that popup type. Generic "free spins" is NOT included for
  // any kind — it appears in too many contexts (FS-trigger banner, buy popup,
  // paytable FS-rules page) to be reliable.
  //
  // Expanded 2026-05-31 after observing vs20rnriches paytable opens to a
  // "FREE SPINS rules" page first → original list (just "paytable"/"pay
  // table"/"symbol payouts") missed it entirely. Added paytable-content
  // vocabulary that's unlikely to appear elsewhere.
  switch (kind) {
    case "menuButton":
      return ["settings", "sound", "music", "language", "volume", "lobby", "quit game"];
    case "paytableButton":
      return [
        "paytable", "pay table",
        "symbol payouts", "symbol values", "winning combinations",
        "wild substitute", "scatter symbol", "scatter pays",
        "multiplier", "bonus symbol", "free spins rules",
        "paylines", "winning ways", "ways to win",
        "rtp", "return to player", "max win",
      ];
    case "historyButton":
      return ["history", "previous rounds", "round id", "spin history", "recent rounds"];
    case "buyBonusButton":
      return ["buy bonus", "buy feature", "buy free spins", "purchase free", "ante bet", "buy chance"];
    case "autoButton":
      return ["autoplay", "auto play", "number of spins", "stop after", "stop on", "loss limit", "single win exceeds"];
    default:
      return [];
  }
}

/**
 * Probe a single element. Returns ok=true when a signal confirms the click
 * landed on the intended target. `probed=false` means "we don't have a probe
 * for this kind" — leave the element pending for QA, no failure.
 */
export async function probeElement(
  page: Page,
  uiKey: string,
  el: UiElement,
): Promise<ProbeResult> {
  const kind = inferProbeKind(uiKey);
  if (!kind) return { ok: false, probed: false, attempts: 0, reason: "no probe defined for uiKey" };
  if (!Number.isFinite(el.x) || !Number.isFinite(el.y)) {
    return { ok: false, probed: true, kind, attempts: 0, reason: "invalid coord" };
  }

  for (let i = 0; i < OFFSETS.length; i++) {
    const off = OFFSETS[i]!;
    const x = Math.round(el.x + off.dx);
    const y = Math.round(el.y + off.dy);
    let signal: string | undefined;
    try {
      switch (kind) {
        case "spinButton": {
          const resp = page.waitForResponse(
            (r) => /gameService|doSpin/i.test(r.url()) && r.request().method() === "POST",
            { timeout: 5000 },
          ).catch(() => null);
          await page.mouse.click(x, y);
          const r = await resp;
          if (r) {
            const body = await r.text().catch(() => "");
            // PP spin responses carry sw/sh (grid dims), s (symbols), tw (total
            // win). reloadBalance.do shares the URL prefix but has none of these.
            if (/\bsw=\d|\bs=[0-9,]+|\btw=/.test(body)) signal = "spinResponse";
          }
          break;
        }
        case "betPlus":
        case "betMinus": {
          // 4-signal probe (revised 2026-06-01 after observing a false
          // positive: OCR garbage text "(r ¥)&" vs "dr ¥)&" differed by 1
          // char + pixDiff=0%, triggering "betOcrTextChanged" → wrong coord
          // marked verified. Two structural fixes:
          //
          //   • REMOVED the "OCR-text-differs" signal. Tesseract is
          //     non-deterministic on icon-heavy regions; even identical
          //     pixels yield slightly different text across calls. Any
          //     real bet change must surface as either (A) network,
          //     (B) parsed numeric change, or (C) substantial visual
          //     change — never as a 1-char text wobble.
          //
          //   • ADDED full-screen popup detection as PRIMARY visual
          //     signal. vs20rnriches and other PP games open a bet
          //     SELECTOR POPUP on +/- click instead of (or in addition
          //     to) directly adjusting the bet readout. A wrong coord
          //     that just nudges an adjacent button rarely opens a
          //     popup → strong negative signal when popup absent.
          //
          // Signal order:
          //   (A) /saveSettings.do response (3s, fast path).
          //   (B) Bet-selector popup detected (OCR contains "bet" / "coin
          //       value" / "lines" / "wager" / "total bet").
          //   (C) Bet readout numeric change.
          //   (D) Full-screen pixel diff >8% (catches popup-open visual
          //       even when OCR misses the keywords).
          const vp = page.viewportSize() ?? { width: 1280, height: 720 };
          const directionX = kind === "betPlus" ? -1 : 1;
          const stripCenterX = Math.round(x + directionX * 100);
          const stripHalfW = 110;
          const stripX = Math.max(0, stripCenterX - stripHalfW);
          const stripY = Math.max(0, y - 30);
          const region = {
            x: stripX,
            y: stripY,
            w: Math.min(220, vp.width - stripX),
            h: Math.min(60, vp.height - stripY),
          };

          // Capture both: bet-readout OCR (for numeric compare) +
          // full-screen buffer (for popup-detection pixel-diff fallback).
          let beforeBet: number | null = null;
          let beforeFullBuf: Buffer | null = null;
          try {
            const ocr = await ocrRegion(page, region);
            beforeBet = parseNumericFromOcr(ocr.text);
          } catch {}
          try {
            beforeFullBuf = await page.screenshot({ type: "png" });
          } catch {}

          const resp = page.waitForResponse(
            (r) => /saveSettings\.do/i.test(r.url()),
            { timeout: 3000 },
          ).catch(() => null);
          await page.mouse.click(x, y);
          const r = await resp;

          if (r) {
            signal = "saveSettings";
          } else {
            await page.waitForTimeout(1500);

            // (B) Bet-selector popup detection. Capture popup detection
            // once + reuse for signal (D) below.
            let popupHit: string | null = null;
            let popupDetected = false;
            let popupText = "";
            try {
              const det = await detectAnyPopup(page, { substateKeywords: SUBSTATE_POPUP_KEYWORDS });
              popupDetected = det.hasPopup;
              popupText = det.detectedText;
              if (det.hasPopup) {
                const betKeywords = ["bet", "coin value", "total bet", "lines", "wager"];
                const m = betKeywords.find((k) => det.detectedText.includes(k));
                if (m) {
                  popupHit = m;
                  signal = `popup:bet-${m}`;
                }
              }
            } catch {}

            // (C) Bet readout numeric change.
            let afterBet: number | null = null;
            if (!signal) {
              try {
                const ocr2 = await ocrRegion(page, region);
                afterBet = parseNumericFromOcr(ocr2.text);
                if (beforeBet !== null && afterBet !== null && Math.abs(afterBet - beforeBet) > 1e-6) {
                  signal = `betOcrNumChanged:${beforeBet}->${afterBet}`;
                }
              } catch {}
            }

            // (D) Substantial full-screen pixel diff WITH bet-ladder
            // evidence in the popup text. Tightened 2026-06-03 after
            // false-positive observation: clicking menuButton (or any
            // adjacent UI) produces pixDiff >8% via the menu drawer
            // opening → probe wrongly marked betPlus/betMinus verified.
            // The fix requires the visual change to (a) be a real popup
            // (detectAnyPopup detected overlay/text) AND (b) contain at
            // least 2 ladder-like values (numeric or "$0.20" patterns)
            // that suggest a bet selector menu. Generic popups (menu
            // drawer, paytable) don't usually carry multiple "$N.NN"
            // values clustered together, so this filters them out.
            let pixDiff = 0;
            let ladderHits = 0;
            if (!signal && beforeFullBuf) {
              try {
                const afterFullBuf = await page.screenshot({ type: "png" });
                pixDiff = await bufferPixelDiff(beforeFullBuf, afterFullBuf);
                if (pixDiff > 0.08 && popupDetected) {
                  // Count distinct monetary-style values in popup text.
                  // Patterns: "$0.20", "0.20", "0,20" — slot bet ladders
                  // typically expose 8-15 such values. 2+ matches → real
                  // bet selector; 0-1 → noise / non-bet popup.
                  const numMatches = popupText.match(/\$?\d+[.,]\d{1,2}\b/g) ?? [];
                  ladderHits = new Set(numMatches).size;
                  if (ladderHits >= 2) {
                    signal = `betFullScreenDiff:${(pixDiff * 100).toFixed(1)}%+ladder:${ladderHits}`;
                  }
                }
              } catch {}
            }

            console.log(
              `[probe/bet] ${kind} offset ${i} (click=${x},${y}): ` +
              `signal=${signal ?? "none"} popup=${popupDetected ? (popupHit ?? "no-kw") : "no"} ` +
              `bet=${beforeBet}->${afterBet} fullPixDiff=${(pixDiff * 100).toFixed(1)}% ladderHits=${ladderHits}`,
            );
          }
          break;
        }
        case "genericToggle": {
          // Local pixel-diff around the click coord — toggles flip a small
          // icon (sound on↔off, music on↔off, ante on↔off). A 140×100
          // region centered on the click covers the typical icon size
          // without picking up ambient animation from the rest of the
          // canvas. 5% local-region diff threshold = the icon clearly
          // flipped (a 30×30 icon fully changing color = ~6.4% of a
          // 140×100 region).
          const vp = page.viewportSize() ?? { width: 1280, height: 720 };
          const localRegion = {
            x: Math.max(0, x - 70),
            y: Math.max(0, y - 50),
            width: Math.min(140, vp.width - Math.max(0, x - 70)),
            height: Math.min(100, vp.height - Math.max(0, y - 50)),
          };
          let beforeBuf: Buffer | null = null;
          try {
            beforeBuf = await page.screenshot({ type: "png", clip: localRegion });
          } catch {}
          try {
            await page.mouse.click(x, y);
          } catch {
            break;
          }
          await page.waitForTimeout(1200);
          if (beforeBuf) {
            try {
              const afterBuf = await page.screenshot({ type: "png", clip: localRegion });
              const diff = await bufferPixelDiff(beforeBuf, afterBuf);
              if (diff > 0.05) {
                signal = `togglePixelDiff:${(diff * 100).toFixed(1)}%`;
              }
            } catch {}
          }
          // Restore — click again to flip the toggle back. Toggles often
          // affect game economics (ante bet, special bets) and we must
          // not leave the state changed after discovery.
          if (signal) {
            try {
              await page.mouse.click(x, y);
              await page.waitForTimeout(500);
            } catch {}
          }
          break;
        }
        case "menuButton":
        case "paytableButton":
        case "historyButton":
        case "buyBonusButton":
        case "autoButton": {
          await page.mouse.click(x, y);
          // Popup animation/layout settle — slot popups typically open within
          // 1-2s; give 2s headroom before OCR.
          await page.waitForTimeout(2000);
          const det = await detectAnyPopup(page, { substateKeywords: SUBSTATE_POPUP_KEYWORDS });
          if (det.hasPopup) {
            // Layer 1 — STRICT positive match. Accept when popup OCR contains
            // a keyword UNIQUE to this kind.
            const want = expectedKeywordsFor(kind);
            const text = det.detectedText;
            const hit = want.find((w) => text.includes(w));
            if (hit) {
              signal = `popup:${hit}`;
            } else if (kind === "paytableButton") {
              // Layer 2 — NEGATIVE-match fallback, paytableButton ONLY.
              // Observed 2026-05-31 on vs20rnriches: paytable opens to a
              // "FREE SPINS rules" page rendered in a stylized title font
              // that Tesseract reads as "free spins" but consistently
              // misses "RULES" / "WILD" / "SCATTER" — Layer 1 returns
              // nothing even though the click was correct. Other kinds
              // (menu/buy/auto/history) have reliable keywords and DON'T
              // need this fallback (applying Layer 2 universally would
              // false-positive when a menuButton click drifts onto
              // paytableButton: paytable popup with no menu keyword AND
              // no other-kind keyword would be wrongly accepted as menu).
              //
              // Fallback rule: accept paytable iff popup is open AND OCR
              // contains NO keyword from any OTHER probeable kind's popup.
              // Buy / menu / auto / history popups each surface their own
              // unique vocabulary on the first OCR pass, so cross-button
              // drift still rejects cleanly.
              const otherKindKeywords = (
                [
                  "menuButton",
                  "historyButton",
                  "buyBonusButton",
                  "autoButton",
                ] as ProbeKind[]
              ).flatMap((k) => expectedKeywordsFor(k));
              const matchedOther = otherKindKeywords.find((w) => text.includes(w));
              if (!matchedOther) {
                signal = `popup:opened-no-other-kind-match`;
              }
            }
          }
          // Restore main state so the next probe starts clean. Best-effort:
          // dismissPopupsLoop handles ESC + corner-click recovery.
          await dismissPopupsLoop(page, 2, 500).catch(() => undefined);
          break;
        }
      }
    } catch (err) {
      // Click/response error → try next offset (don't blow up the whole probe).
    }
    if (signal) {
      return { ok: true, probed: true, kind, signal, attempts: i + 1, finalCoord: { x, y } };
    }
  }

  // Every offset failed — make sure we leave the game on MAIN before bailing.
  await dismissPopupsLoop(page, 3, 800).catch(() => undefined);
  return { ok: false, probed: true, kind, attempts: OFFSETS.length, reason: "no signal after offset retries" };
}
