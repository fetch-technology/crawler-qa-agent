// AI: opt-in UI verifier — OCR balance/bet/win on canvas after a spin,
// compare to API response. ONE AI vision call per session (not per spin).
// Gated by QA_VERIFY_UI=1 since OCR cost is non-trivial.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import {
  transcribePlayScreenValues,
  type TranscribedScreenValues,
} from "../../ai/vision.js";
import type { NormalizedSpinResult } from "../step6-build-model/normalized.js";
import { dirForGame } from "../registry/paths.js";

export type UiCheck = {
  field: "balance" | "bet" | "win";
  apiValue: number;
  uiValue: number | null;
  match: boolean;
  delta: number | null;
  detail?: string;
};

export type UiVerifyResult = {
  ok: boolean;
  ran: boolean;
  checks: UiCheck[];
  raw: TranscribedScreenValues | null;
  reason?: string;
};

const TOLERANCE = 0.01;

export async function verifyUi(
  page: Page,
  gameSlug: string,
  lastSpin: NormalizedSpinResult,
): Promise<UiVerifyResult> {
  // Capture screenshot
  const dir = path.join(dirForGame(gameSlug), "ui-verify");
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = path.join(dir, `${ts}.png`);
  const buf = await page.screenshot({ type: "png" });
  await writeFile(screenshotPath, buf);

  // OCR
  let ocr: TranscribedScreenValues;
  try {
    ocr = await transcribePlayScreenValues({ screenshotPath });
  } catch (err) {
    return {
      ok: false,
      ran: true,
      checks: [],
      raw: null,
      reason: `OCR failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const checks: UiCheck[] = [];

  // Balance check
  checks.push(buildCheck("balance", lastSpin.balanceAfter, ocr.balance));
  // Bet check (skip for free-spin where bet=0)
  if (!lastSpin.isFreeSpin && lastSpin.bet > 0) {
    checks.push(buildCheck("bet", lastSpin.bet, ocr.bet));
  }
  // Win check (only if last_win was actually visible — null means "didn't display")
  if (lastSpin.win > 0 || ocr.last_win != null) {
    checks.push(buildCheck("win", lastSpin.win, ocr.last_win));
  }

  const ok = checks.every((c) => c.match || c.uiValue == null);
  return { ok, ran: true, checks, raw: ocr };
}

function buildCheck(
  field: UiCheck["field"],
  apiValue: number,
  uiValue: number | null,
): UiCheck {
  if (uiValue == null) {
    return {
      field,
      apiValue,
      uiValue: null,
      match: true,
      delta: null,
      detail: "field not visible / unreadable on screen",
    };
  }
  const delta = Math.abs(apiValue - uiValue);
  const match = delta < TOLERANCE;
  return {
    field,
    apiValue,
    uiValue,
    match,
    delta,
    detail: match
      ? undefined
      : `mismatch: api=${apiValue.toFixed(2)} ui=${uiValue.toFixed(2)} delta=${delta.toFixed(2)}`,
  };
}
