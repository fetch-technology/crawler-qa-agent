import type { PlayScreenSnapshot } from "../../ai/vision.js";
import type { ApiSnapshot } from "./types.js";

/**
 * Derive `ui_options` từ vision PlayScreenSnapshot.
 *
 * Lý do: autoplay/sound/turbo/quick-spin là client-side, không xuất hiện ở
 * response API. Vision đã thấy controls trên play-screen — đủ để biết features
 * nào tồn tại + state mặc định (qua state_hint icon).
 *
 * Nếu cần chi tiết hơn (autoplay max rounds, presets cụ thể), phải mở settings
 * panel + chạy `transcribeOptionsPanel` (cost thêm 5-10s + 1 AI call).
 */

function findControl(snap: PlayScreenSnapshot, namePattern: RegExp) {
  return snap.controls.find((c) => namePattern.test(c.name));
}

function inferToggleState(stateHint: string | null): "on" | "off" | null {
  if (!stateHint) return null;
  if (/\bon\b|enabled|active|unmuted/i.test(stateHint)) return "on";
  if (/\boff\b|disabled|muted/i.test(stateHint)) return "off";
  return null;
}

export function deriveUiOptionsFromVision(snap: PlayScreenSnapshot): ApiSnapshot["ui_options"] {
  if (!snap || !snap.controls || snap.controls.length === 0) return null;

  const autoplayCtl = findControl(snap, /autoplay|autospin|auto[\s-]?play/i);
  const soundCtl = findControl(snap, /sound|mute|audio/i);
  const turboCtl = findControl(snap, /turbo/i);
  const quickCtl = findControl(snap, /quick[\s-]?spin/i);
  const fullscreenCtl = findControl(snap, /full[\s-]?screen/i);

  // Liệt kê các controls còn lại không thuộc nhóm trên cho dev visibility
  const known = new Set(
    [autoplayCtl, soundCtl, turboCtl, quickCtl, fullscreenCtl].filter(Boolean).map((c) => c!.name),
  );
  const otherControls = snap.controls
    .filter((c) => !known.has(c.name))
    .filter((c) => !/^(spin|bet|menu|info|back|exit)/i.test(c.name))   // skip core nav
    .map((c) => c.name);

  return {
    autoplay: autoplayCtl
      ? {
          available: true,
          presets: null,                  // unknown until we open the panel
          max_rounds: null,
          stop_on_any_win: null,
          stop_on_feature: null,
          stop_on_balance_increase: null,
          stop_on_balance_decrease: null,
          stop_on_single_win_gt: null,
        }
      : { available: false, presets: null, max_rounds: null, stop_on_any_win: null, stop_on_feature: null, stop_on_balance_increase: null, stop_on_balance_decrease: null, stop_on_single_win_gt: null },
    sound: soundCtl
      ? {
          available: true,
          default_state: inferToggleState(soundCtl.state_hint),
          separate_music_fx: null,
        }
      : null,
    turbo_spin: turboCtl
      ? { available: true, default_state: inferToggleState(turboCtl.state_hint) }
      : null,
    quick_spin: quickCtl
      ? { available: true, default_state: inferToggleState(quickCtl.state_hint) }
      : null,
    languages: null,                       // không suy được từ play-screen
    fullscreen: fullscreenCtl ? { available: true } : null,
    other_controls: otherControls.length ? otherControls : null,
  };
}
