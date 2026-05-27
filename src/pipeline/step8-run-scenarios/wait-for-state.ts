// Deterministic state detector — uses (network response state) + (OCR text signature)
// + (pixel signature). NEVER calls AI.

import type { Page } from "playwright";
import type { BaseParser } from "../step6-build-model/base-parser.js";
import type { NormalizedSpinResult, SpinState } from "../step6-build-model/normalized.js";
import type { CaptureHandle } from "../step3-capture-network/types.js";
import type { StateSignatures } from "../registry/types.js";
import { diffVsBaseline } from "../utils/pixel-diff/index.js";

export type WaitOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
};

export type WaitResult =
  | { ok: true; state: SpinState; source: "network" | "pixel" | "ocr" }
  | { ok: false; reason: string };

/**
 * Wait until game enters the desired state. Tries sources in order:
 *   1. NETWORK — newest parsed spin response from capture (most reliable)
 *   2. PIXEL — state-signatures.json has a template/baseline screenshot at a region
 *   3. (OCR — wired later when tesseract.js added)
 *
 * Returns immediately on first success. Times out with ok=false after timeoutMs.
 */
export async function waitForState(
  page: Page,
  desired: SpinState,
  ctx: {
    capture: CaptureHandle;
    parser: BaseParser;
    stateSignatures?: StateSignatures | null;
  },
  opts: WaitOptions = {},
): Promise<WaitResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? 5000;
  const interval = opts.pollIntervalMs ?? 200;

  while (Date.now() - start < timeoutMs) {
    // Source 1: network — newest spin response declaring the state.
    const rounds = ctx.capture.flush();
    for (const round of rounds) {
      for (const res of round.responses) {
        if (res.body && ctx.parser.canParseResponse(res.body, res.url)) {
          try {
            const spin: NormalizedSpinResult = ctx.parser.parseResponse(res.body);
            if (spin.state === desired) {
              return { ok: true, state: spin.state, source: "network" };
            }
          } catch {
            // ignore parse errors
          }
        }
      }
    }

    // Source 2: pixel signature (template/baseline at known region).
    const sig = ctx.stateSignatures
      ? (ctx.stateSignatures as Record<string, { kind: string; image?: string; region: { x: number; y: number; width: number; height: number } } | undefined>)[desired]
      : undefined;
    if (sig && sig.kind === "template" && sig.image) {
      try {
        const baselineBuf = await fetchTemplate(sig.image);
        const { changed } = await diffVsBaseline(page, baselineBuf, sig.region, {
          changeThreshold: 0.1,
        });
        if (!changed) {
          return { ok: true, state: desired, source: "pixel" };
        }
      } catch {
        // template missing — fall through
      }
    }

    await page.waitForTimeout(interval);
  }

  return { ok: false, reason: `timeout waiting for state ${desired}` };
}

async function fetchTemplate(imagePath: string): Promise<Buffer> {
  const { readFile } = await import("node:fs/promises");
  return readFile(imagePath);
}
