import type { UiRegistry } from "../registry/types.js";
import type { GeneratedTestcase } from "./types.js";

export function generateFromRegistry(uiMap: UiRegistry): GeneratedTestcase[] {
  const cases: GeneratedTestcase[] = [];

  cases.push({
    id: "tc-smoke-load",
    title: "Game loads successfully",
    category: "smoke",
    steps: ["Open game URL", "Wait until network idle"],
    expected: "Canvas/iframe present, no console errors",
    priority: "high",
  });

  if (uiMap.spinButton) {
    cases.push({
      id: "tc-balance-deduct",
      title: "Balance deducts on spin",
      category: "balance",
      steps: ["Capture before-balance", "Click spin", "Capture after-balance"],
      expected: "after === before - bet + win",
      priority: "high",
    });
  }

  if (uiMap.buyBonusButton) {
    cases.push({
      id: "tc-buy-bonus-cost",
      title: "Buy bonus deducts exact cost",
      category: "buy-bonus",
      steps: ["Click buy-bonus", "Confirm", "Capture balance"],
      expected: "after === before - buyCost; state enters BONUS",
      priority: "high",
    });
  }

  if (uiMap.historyButton) {
    cases.push({
      id: "tc-history-reconcile",
      title: "History rows match captured spins",
      category: "history",
      steps: ["Run N spins", "Open history", "OCR rows", "Compare with captured"],
      expected: "Each row matches roundId/bet/win/balance from network",
      priority: "high",
    });
  }

  if (uiMap.paytableButton) {
    cases.push({
      id: "tc-paytable",
      title: "Paytable popup content matches expected",
      category: "paytable",
      steps: ["Click paytable", "OCR symbols + payouts", "Diff vs expected JSON"],
      expected: "All symbols and payouts present and equal",
      priority: "medium",
    });
  }

  cases.push({
    id: "tc-rtp-range",
    title: "RTP within expected range over N spins",
    category: "rtp",
    steps: ["Run 10000 API-mode spins", "Aggregate"],
    expected: "0.94 <= RTP <= 0.98",
    priority: "high",
  });

  return cases;
}
