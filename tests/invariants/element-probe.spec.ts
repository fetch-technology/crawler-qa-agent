// INVARIANT — probe-kind inference for AI auto-discover (P1).
//
// inferProbeKind decides whether a uiKey has a deterministic probe
// signature. A wrong answer here would either (a) skip probing for a key we
// COULD verify → element stays pending → QA bottleneck, or (b) probe a key we
// SHOULDN'T → bogus verify by clicking the wrong thing. Lock the map.

import { test, expect } from "@playwright/test";
import { inferProbeKind } from "../../src/pipeline/step2-detect-ui/element-probe.js";

test("canonical main-screen keys are probeable", () => {
  expect(inferProbeKind("spinButton")).toBe("spinButton");
  expect(inferProbeKind("betPlus")).toBe("betPlus");
  expect(inferProbeKind("betMinus")).toBe("betMinus");
  expect(inferProbeKind("menuButton")).toBe("menuButton");
  expect(inferProbeKind("paytableButton")).toBe("paytableButton");
  expect(inferProbeKind("historyButton")).toBe("historyButton");
  expect(inferProbeKind("buyBonusButton")).toBe("buyBonusButton");
  expect(inferProbeKind("autoButton")).toBe("autoButton");
});

test("sub-state-scoped keys are unprobeable in P1 (need popup context)", () => {
  // Bet rung only works when bet selector is open — context-dependent.
  expect(inferProbeKind("betPlus__betAmount-0.50")).toBeNull();
  expect(inferProbeKind("betMinus__betAmount-1.00")).toBeNull();
  // Close button needs to be inside a popup; standalone probe would no-op.
  expect(inferProbeKind("closePopupButton")).toBeNull();
  // Sub-state child elements.
  expect(inferProbeKind("buy_feature_popup__yesButton")).toBeNull();
  expect(inferProbeKind("autoplay_popup__startButton")).toBeNull();
});

test("turbo / unknown / cosmetic keys are unprobeable", () => {
  // turboButton is a toggle without a network signature → no deterministic
  // signal in P1; could add screenshot-diff probe later.
  expect(inferProbeKind("turboButton")).toBeNull();
  expect(inferProbeKind("balanceDisplay")).toBeNull();
  expect(inferProbeKind("logo")).toBeNull();
  expect(inferProbeKind("")).toBeNull();
});

test("case-sensitive — typos / wrong casing don't accidentally match", () => {
  expect(inferProbeKind("SpinButton")).toBeNull();
  expect(inferProbeKind("spin_button")).toBeNull();
  expect(inferProbeKind("BetPlus")).toBeNull();
});
