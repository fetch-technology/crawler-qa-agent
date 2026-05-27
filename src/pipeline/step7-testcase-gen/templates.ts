import type { FeatureName } from "../step4-feature-discovery/types.js";

export type TestcaseTemplate = {
  templateId: string;
  feature: FeatureName | "core";
  title: string;
  category:
    | "balance"
    | "free-spin"
    | "buy-bonus"
    | "history"
    | "paytable"
    | "payline"
    | "jackpot"
    | "smoke"
    | "rtp"
    | "respin"
    | "multiplier"
    | "gamble"
    | "turbo"
    | "auto-spin";
  priority: "high" | "medium" | "low";
  steps: string[];
  expected: string;
  /** Parameter placeholders like ${spinButton} or ${buyBonusApi} that AI/registry fills. */
  parameters: string[];
};

export const TEMPLATES: TestcaseTemplate[] = [
  {
    templateId: "core.smoke-load",
    feature: "core",
    title: "Game loads successfully",
    category: "smoke",
    priority: "high",
    steps: ["Open game URL", "Wait until network idle"],
    expected: "Canvas/iframe present, no console errors",
    parameters: [],
  },
  {
    templateId: "core.balance-deduct",
    feature: "core",
    title: "Balance deducts on normal spin",
    category: "balance",
    priority: "high",
    steps: [
      "Capture before-balance",
      "Click ${spinButton}",
      "Wait response ${spinApi}",
      "Capture after-balance",
    ],
    expected: "after === before - bet + win",
    parameters: ["spinButton", "spinApi"],
  },
  {
    templateId: "buyBonus.exact-cost",
    feature: "buyBonus",
    title: "Buy bonus deducts exact cost",
    category: "buy-bonus",
    priority: "high",
    steps: [
      "Capture before-balance",
      "Click ${buyBonusButton}",
      "Read displayed cost",
      "Click confirm",
      "Wait ${buyBonusApi}",
      "Capture after-balance",
    ],
    expected: "after === before - displayedCost; state enters BONUS",
    parameters: ["buyBonusButton", "buyBonusApi"],
  },
  {
    templateId: "freeSpin.no-deduct",
    feature: "freeSpin",
    title: "Free spin must not deduct balance",
    category: "free-spin",
    priority: "high",
    steps: [
      "Trigger free spin (via scatter or buy)",
      "Wait FREE_SPIN state",
      "Capture before-balance",
      "Click ${spinButton}",
      "Capture after-balance",
    ],
    expected: "after === before + win (no bet deducted)",
    parameters: ["spinButton"],
  },
  {
    templateId: "freeSpin.counter-decreases",
    feature: "freeSpin",
    title: "Free spin counter decreases each spin",
    category: "free-spin",
    priority: "high",
    steps: [
      "Enter FREE_SPIN",
      "Read counter via OCR ${freeSpinCounter}",
      "Click ${spinButton}",
      "Read counter again",
    ],
    expected: "counter decreases by 1 each spin until 0",
    parameters: ["spinButton", "freeSpinCounter"],
  },
  {
    templateId: "respin.retrigger",
    feature: "respin",
    title: "Respin / retrigger adds extra spins",
    category: "respin",
    priority: "medium",
    steps: ["Enter free spin", "Trigger retrigger by scatter", "Read counter"],
    expected: "counter incremented by retrigger award",
    parameters: [],
  },
  {
    templateId: "multiplier.applied",
    feature: "multiplier",
    title: "Multiplier applied to win",
    category: "multiplier",
    priority: "medium",
    steps: ["Spin until multiplier triggers", "Read win value", "Compare to base × multiplier"],
    expected: "win === baseWin × multiplier",
    parameters: [],
  },
  {
    templateId: "gamble.win-lose",
    feature: "gamble",
    title: "Gamble doubles balance on win, zeroes on lose",
    category: "gamble",
    priority: "medium",
    steps: ["Win a normal spin", "Click ${gambleButton}", "Pick color/suit", "Verify outcome"],
    expected: "win × 2 on success, 0 on fail",
    parameters: ["gambleButton"],
  },
  {
    templateId: "jackpot.added-once",
    feature: "jackpot",
    title: "Jackpot persists and adds only once per round",
    category: "jackpot",
    priority: "high",
    steps: ["Wait jackpot trigger", "Capture balance", "Re-load page", "Check history"],
    expected: "jackpot amount added once, persisted across reload",
    parameters: [],
  },
  {
    templateId: "history.persistence",
    feature: "history",
    title: "History contains last round",
    category: "history",
    priority: "high",
    steps: [
      "Spin",
      "Save roundId from ${spinApi}",
      "Click ${historyButton}",
      "OCR history popup ${historyPopup}",
    ],
    expected: "saved roundId visible in history; bet/win/balance match",
    parameters: ["spinApi", "historyButton", "historyPopup"],
  },
  {
    templateId: "paytable.content",
    feature: "paytable",
    title: "Paytable popup shows expected symbols and payouts",
    category: "paytable",
    priority: "medium",
    steps: ["Click ${paytableButton}", "OCR popup ${paytablePopup}", "Diff vs expected JSON"],
    expected: "all symbols and payouts present and equal",
    parameters: ["paytableButton", "paytablePopup"],
  },
  {
    templateId: "turbo.faster",
    feature: "turbo",
    title: "Turbo mode shortens animation",
    category: "turbo",
    priority: "low",
    steps: ["Time normal spin", "Click ${turboButton}", "Time turbo spin"],
    expected: "turbo duration < normal duration",
    parameters: ["turboButton"],
  },
  {
    templateId: "autoSpin.stop",
    feature: "autoSpin",
    title: "Auto spin stops when player clicks stop",
    category: "auto-spin",
    priority: "low",
    steps: ["Click ${autoButton}", "Pick count", "Click stop mid-way"],
    expected: "auto stops cleanly, no extra spins fired",
    parameters: ["autoButton"],
  },
  {
    templateId: "rtp.range",
    feature: "core",
    title: "RTP within expected range over N spins",
    category: "rtp",
    priority: "high",
    steps: ["Run ${spinCount} API-mode spins", "Aggregate totalWin/totalBet"],
    expected: "0.94 <= RTP <= 0.98",
    parameters: ["spinCount"],
  },
];
