// Handler registry. Maps ObservedState → handler implementation.
// Caller (adaptive runner) looks up by state + falls back to "unknown" if
// state isn't in registry.

import type { ObservedState } from "../state-observer.js";
import type { InterruptHandler } from "./types.js";
import { bigWinHandler } from "./big-win.js";
import { freeSpinHandler } from "./free-spin.js";
import { makeDismissPopupHandler } from "./dismiss-popup.js";

export const HANDLER_REGISTRY: Partial<Record<ObservedState, InterruptHandler>> = {
  BIG_WIN_POPUP: bigWinHandler,
  FREE_SPIN_TRIGGERED: freeSpinHandler,
  PAYTABLE_POPUP: makeDismissPopupHandler("paytable-dismiss", "paytableButton__closeButton"),
  AUTOPLAY_POPUP: makeDismissPopupHandler("autoplay-dismiss", "autoButton__closeButton"),
  HISTORY_POPUP: makeDismissPopupHandler("history-dismiss", "historyButton__closeButton"),
  SETTINGS_POPUP: makeDismissPopupHandler("settings-dismiss", "settingsButton__closeButton"),
  BUY_FEATURE_POPUP: makeDismissPopupHandler("buy-feature-dismiss", "buyBonusButton__closeButton"),
};

export function getHandler(state: ObservedState): InterruptHandler | null {
  return HANDLER_REGISTRY[state] ?? null;
}

export type { HandlerContext, HandlerOutcome, InterruptHandler } from "./types.js";
