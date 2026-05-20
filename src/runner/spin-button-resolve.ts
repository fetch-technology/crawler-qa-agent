/**
 * Resolve spin button coord at runtime — bbox từ vision call (live, không
 * stale) ưu tiên hơn SPIN_BUTTON hardcode từ recording.
 *
 * Dùng trong generated hybrid spec:
 *   const ready = await preGameWithReplayOrVision(page, { slug: SLUG, ... });
 *   const sb = resolveSpinButton(ready, SPIN_BUTTON);
 *   const result = await spinReal(page, { spinButton: sb.coord, skipScale: sb.live });
 *
 * Khi vision return bbox:
 *   - `coord` = bbox center (viewport px, cùng frame với screenshot)
 *   - `live`  = true → spinReal/Caller skip 1440×900 → actualViewport scaling
 *
 * Khi không có bbox (replay path, vision không locate được):
 *   - `coord` = fallback (SPIN_BUTTON từ recording, 1440×900 space)
 *   - `live`  = false → spinReal scale như cũ
 */

import type { SpinButtonBbox } from "../ai/vision.js";

export type ResolvedSpinButton = {
  coord: { x: number; y: number };
  /** True khi coord lấy từ vision live — caller nên pass skipScale=true. */
  live: boolean;
  source: "vision_bbox" | "recording_fallback" | "vision_rejected_fallback";
};

const MAX_LIVE_DELTA_X = 140;
const MAX_LIVE_DELTA_Y = 90;

export function resolveSpinButton(
  ready: { spinButtonBbox?: SpinButtonBbox | null },
  fallback: { x: number; y: number },
): ResolvedSpinButton {
  const bbox = ready.spinButtonBbox;
  if (bbox) {
    const cx = Math.round(bbox.x + bbox.w / 2);
    const cy = Math.round(bbox.y + bbox.h / 2);
    const dx = Math.abs(cx - fallback.x);
    const dy = Math.abs(cy - fallback.y);
    // Guardrail: fixed viewport runs should keep spin center close to recording.
    // If vision drifts too far, prefer fallback to avoid clicking nearby controls.
    if (dx > MAX_LIVE_DELTA_X || dy > MAX_LIVE_DELTA_Y) {
      return { coord: fallback, live: false, source: "vision_rejected_fallback" };
    }
    return { coord: { x: cx, y: cy }, live: true, source: "vision_bbox" };
  }
  return { coord: fallback, live: false, source: "recording_fallback" };
}
