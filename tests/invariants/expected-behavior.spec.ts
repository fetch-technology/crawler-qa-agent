// Pure tests for expectedBehaviorFor — verifies that every key naming
// pattern observed in real registries maps to a meaningful expected-
// behavior description for the verify-click agent. Each description must
// describe what TO LOOK FOR (popup-close, page transition, toggle flip,
// network activity) AND explicit rejection signals (real spin, wrong
// popup, no response) so the agent can produce reliable verdicts.

import { test, expect } from "@playwright/test";
import { expectedBehaviorFor } from "../../src/pipeline/registry/expected-behavior.ts";

// Helper: every behavior string must include AT LEAST one rejection signal
// (mentions spin/MUST NOT/etc.) so the agent has explicit fail criteria.
function assertHasRejectionSignal(behavior: string, key: string): void {
  const hasReject = /MUST NOT|should not|reject|wrong|caution/i.test(behavior);
  expect(hasReject, `behavior for "${key}" should describe explicit rejection signals`).toBe(true);
}

test.describe("dismissal keys", () => {
  for (const key of [
    "paytableButton__closeButton",
    "menuButton__closeButton",
    "buyBonusButton__cancelButton",
    "betPlus__closeButton",
    "settingsPopup__backButton",
    "paytableButton__exitPaytableButton",
  ]) {
    test(`${key} → "should close popup"`, () => {
      const b = expectedBehaviorFor(key);
      expect(b.toLowerCase()).toMatch(/close|previous screen|popup is gone/);
      assertHasRejectionSignal(b, key);
    });
  }
});

test.describe("bet-level keys", () => {
  for (const key of [
    "betPlus__bet-0.20",
    "betPlus__bet-100.00",
    "betMinus__bet-5.00",
    "betMinus__bet-87.50",
  ]) {
    test(`${key} → "should select bet level"`, () => {
      const b = expectedBehaviorFor(key);
      expect(b.toLowerCase()).toMatch(/bet level|select.*bet|bet readout/);
      expect(b.toLowerCase()).toMatch(/must not.*spin/);
    });
  }
});

test.describe("pagination keys", () => {
  test("nextPageButton → navigate forward, popup stays open", () => {
    const b = expectedBehaviorFor("paytableButton__nextPageButton");
    expect(b.toLowerCase()).toMatch(/navigate|different page|page content changes/);
    expect(b.toLowerCase()).toMatch(/must not.*close|stays open/);
  });

  test("prevPageButton → navigate back", () => {
    const b = expectedBehaviorFor("paytableButton__prevPageButton");
    expect(b.toLowerCase()).toMatch(/navigate|previous page/);
  });

  test("paytableButton__page2Button → page navigation", () => {
    const b = expectedBehaviorFor("paytableButton__page2Button");
    expect(b.toLowerCase()).toMatch(/page|navigate/);
  });
});

test.describe("toggle keys", () => {
  for (const key of [
    "sound_toggle",
    "ante_bet_toggle",
    "more_scatters_toggle",
    "settingsPopup__musicToggle",
    "autoButton__turboSpinToggle",
  ]) {
    test(`${key} → "toggle state"`, () => {
      const b = expectedBehaviorFor(key);
      expect(b.toLowerCase()).toMatch(/toggle|flip|icon/);
      assertHasRejectionSignal(b, key);
    });
  }
});

test.describe("slider keys", () => {
  test("autospinsSlider → adjust slider", () => {
    const b = expectedBehaviorFor("autoButton__autospinsSlider");
    expect(b.toLowerCase()).toMatch(/slider|thumb|snap.*point/);
    expect(b.toLowerCase()).toMatch(/must not.*close|stays open/i);
  });
});

test.describe("autoplay-options keys", () => {
  test("lossLimitButton → open sub-popup for input", () => {
    const b = expectedBehaviorFor("autoButton__lossLimitButton");
    expect(b.toLowerCase()).toMatch(/limit|sub-popup|input/);
  });

  test("stopOnAnyWin → toggle autoplay stop condition", () => {
    const b = expectedBehaviorFor("autoButton__stopOnAnyWin");
    expect(b.toLowerCase()).toMatch(/stop|condition|toggle/);
    expect(b.toLowerCase()).toMatch(/must not.*start autoplay/i);
  });
});

test.describe("commit keys (real money)", () => {
  test("confirmButton → commits, may spend money", () => {
    const b = expectedBehaviorFor("buyBonusButton__confirmButton");
    expect(b.toLowerCase()).toMatch(/commit|purchase|money|consume/);
  });

  test("yesButton → commits", () => {
    const b = expectedBehaviorFor("buyBonusButton__yesButton");
    expect(b.toLowerCase()).toMatch(/commit|purchase/);
  });

  test("startAutoplayButton → starts autoplay loop", () => {
    const b = expectedBehaviorFor("autoButton__startAutoplayButton");
    expect(b.toLowerCase()).toMatch(/autoplay|loop|spins/);
  });
});

test.describe("info / sub-screen keys", () => {
  test("languageButton → opens language sub-screen", () => {
    const b = expectedBehaviorFor("settingsPopup__languageButton");
    expect(b.toLowerCase()).toMatch(/info|sub-screen|sub-section|sub-popup/);
  });

  test("gameHistoryButton → opens history view", () => {
    const b = expectedBehaviorFor("menuButton__gameHistoryButton");
    expect(b.toLowerCase()).toMatch(/history/);
  });

  test("symbolButton → shows symbol detail", () => {
    const b = expectedBehaviorFor("paytableButton__symbolButton");
    expect(b.toLowerCase()).toMatch(/symbol|detail|payout/);
  });
});

test.describe("unknown / fallback keys", () => {
  test("unknown key → default behavior with rejection signals", () => {
    const b = expectedBehaviorFor("foo_bar_baz");
    // Default behavior must still describe rejection signals (no spin, etc.)
    expect(b.toLowerCase()).toMatch(/must not.*spin/);
  });

  test("nested namespace key still classifies by LAST segment", () => {
    // The last-segment is "closeButton" → should map to dismissal behavior
    // regardless of how deeply nested.
    const b = expectedBehaviorFor("buyBonusButton__cancelButton__closeButton");
    expect(b.toLowerCase()).toMatch(/close|previous screen/);
  });
});

test.describe("contains explicit no-spin rejection signal", () => {
  // Smoke test: across a variety of common keys, the agent must always
  // be warned about the "did I accidentally trigger a spin?" failure mode.
  for (const key of [
    "paytableButton__nextPageButton",
    "autoButton__autospinsSlider",
    "settingsPopup__musicToggle",
    "betPlus__bet-1.00",
    "more_scatters_toggle__betPlus",
  ]) {
    test(`${key} mentions spin-rejection`, () => {
      const b = expectedBehaviorFor(key);
      expect(b.toLowerCase()).toMatch(/spin|must not.*spin/i);
    });
  }
});
