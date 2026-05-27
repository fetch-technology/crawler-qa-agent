export type TestcaseId = string;

export type GeneratedTestcase = {
  id: TestcaseId;
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
  steps: string[];
  expected: string;
  priority: "high" | "medium" | "low";
};

export type TestcaseDocument = {
  game: string;
  generatedAt: string;
  testcases: GeneratedTestcase[];
};
