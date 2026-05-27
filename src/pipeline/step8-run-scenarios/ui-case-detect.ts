// Pure helpers for detecting UI-only case shapes. Extracted from
// case-executor.ts so detection logic can be unit-tested without spinning up
// a Playwright page.

import type { CaseAction } from "../step7-testcase-gen/case-action-translator.js";

const OPEN_BTN_RE = /^(info|paytable|history|settings|menu|rules|help)/i;
const CLOSE_BTN_RE = /closeButton|close_btn|__close/i;

const clickUiKey = (a: CaseAction): string =>
  a.kind === "click" ? a.uiKey : "";

export function isOpenUiKey(uiKey: string): boolean {
  return OPEN_BTN_RE.test(uiKey) && !CLOSE_BTN_RE.test(uiKey);
}

export function isCloseUiKey(uiKey: string): boolean {
  return CLOSE_BTN_RE.test(uiKey);
}

/**
 * UI-only case: action plan never spins AND contains at least one OPEN +
 * one CLOSE button click. These are the candidates for synthetic UI
 * assertions (pixel-diff baseline ↔ post-close).
 */
export function detectUiOnlyCase(actions: CaseAction[]): {
  isUiOnlyCase: boolean;
  noSpinActions: boolean;
  hasOpenCloseUiActions: boolean;
  endsOnReopen: boolean;
} {
  const noSpinActions = !actions.some((a) => a.kind === "spin");
  const hasOpen = actions.some((a) => a.kind === "click" && isOpenUiKey(clickUiKey(a)));
  const hasClose = actions.some((a) => a.kind === "click" && isCloseUiKey(clickUiKey(a)));
  const hasOpenCloseUiActions = hasOpen && hasClose;

  // "Ends on reopen" — last meaningful click is an OPEN button. Catches
  // setup_instructions of the form "open → toggle → close → reopen and verify
  // state persists". In those cases the popup is INTENTIONALLY open at the
  // end → the _auto_returned_to_main_after_close synthetic would false-fail.
  const lastClick = [...actions].reverse().find((a) => a.kind === "click");
  const endsOnReopen = Boolean(lastClick && isOpenUiKey(clickUiKey(lastClick)));

  return {
    isUiOnlyCase: noSpinActions && hasOpenCloseUiActions,
    noSpinActions,
    hasOpenCloseUiActions,
    endsOnReopen,
  };
}
