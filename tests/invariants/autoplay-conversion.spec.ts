// INVARIANT — translator auto-converts a long uniform discrete-spin run into
// the game's native autoplay (deterministic post-process), so re-translate
// reliably produces autoplay without manual editing.
import { test, expect } from "@playwright/test";
import { maybeConvertToAutoplay, buildAutoplayBatch } from "../../src/pipeline/step7-testcase-gen/case-action-translator.ts";
import type { CaseAction } from "../../src/pipeline/step7-testcase-gen/case-action-translator.ts";
import type { UiRegistry } from "../../src/pipeline/registry/types.ts";

const el = (x = 1, y = 1) => ({ x, y, strategy: "coord" }) as unknown as UiRegistry[string];

// Registry exposing the autoplay UI with the usual PP preset tiles.
const REG_WITH_AUTOPLAY = {
  spinButton: el(), autoButton: el(), "autoButton__startAutoplayButton": el(),
  "autoButton__autoCountSlide-10": el(), "autoButton__autoCountSlide-20": el(),
  "autoButton__autoCountSlide-30": el(), "autoButton__autoCountSlide-50": el(),
  "autoButton__autoCountSlide-70": el(), "autoButton__autoCountSlide-100": el(),
  "autoButton__autoCountSlide-500": el(), "autoButton__autoCountSlide-1000": el(),
} as unknown as UiRegistry;

const spinRun = (n: number): CaseAction[] => {
  const out: CaseAction[] = [{ kind: "ensure_ante_off" }, { kind: "set_bet_to_min" }];
  for (let i = 0; i < n; i++) { out.push({ kind: "spin" }); out.push({ kind: "wait_ms", ms: 2500 }); }
  return out;
};

function autoplayTile(actions: CaseAction[]): number | null {
  const a = actions.find((x) => x.kind === "click" && /autoCountSlide-(\d+)/.test((x as { uiKey?: string }).uiKey ?? ""));
  const m = a && /autoCountSlide-(\d+)/.exec((a as { uiKey: string }).uiKey);
  return m ? Number(m[1]) : null;
}

test("free_spins watch → converts to autoplay at the HIGHEST tile (1000)", () => {
  const out = maybeConvertToAutoplay(spinRun(5), { category: "free_spins", spinCount: 60, uiMap: REG_WITH_AUTOPLAY });
  expect(out.some((a) => a.kind === "click" && (a as { uiKey: string }).uiKey === "autoButton")).toBe(true);
  expect(out.some((a) => a.kind === "wait_until_no_spin_response")).toBe(true);
  expect(out.some((a) => a.kind === "spin")).toBe(false); // discrete spins replaced
  expect(autoplayTile(out)).toBe(1000); // FS watch maximises trigger chance
  expect(out[0]!.kind).toBe("ensure_ante_off"); // prelude preserved
});

test("long base multi-spin (≥20) → converts to smallest tile that covers target", () => {
  const out = maybeConvertToAutoplay(spinRun(30), { category: "base_game", spinCount: 30, uiMap: REG_WITH_AUTOPLAY });
  expect(autoplayTile(out)).toBe(30); // smallest preset >= 30
  expect(out.some((a) => a.kind === "spin")).toBe(false);
});

test("short non-FS run (<20) stays discrete", () => {
  const actions = spinRun(5);
  const out = maybeConvertToAutoplay(actions, { category: "base_game", spinCount: 5, uiMap: REG_WITH_AUTOPLAY });
  expect(out).toEqual(actions); // unchanged
  expect(out.filter((a) => a.kind === "spin").length).toBe(5);
});

test("no autoplay UI in registry → stays discrete", () => {
  const reg = { spinButton: el() } as unknown as UiRegistry;
  const actions = spinRun(60);
  const out = maybeConvertToAutoplay(actions, { category: "free_spins", spinCount: 60, uiMap: reg });
  expect(out).toEqual(actions);
});

test("non-uniform run (bet change interspersed) is NOT converted", () => {
  const actions: CaseAction[] = [
    { kind: "spin" }, { kind: "set_bet_to_value", value: 0.4 }, { kind: "spin" },
    ...Array.from({ length: 25 }, () => ({ kind: "spin" as const })),
  ];
  const out = maybeConvertToAutoplay(actions, { category: "base_game", spinCount: 27, uiMap: REG_WITH_AUTOPLAY });
  expect(out).toEqual(actions); // has set_bet between spins → leave discrete
});

// buildAutoplayBatch — reused by payout calibration to run a per-level batch
// as one native autoplay instead of N discrete spins.
test("buildAutoplayBatch picks smallest tile >= target and emits start+wait", () => {
  const b = buildAutoplayBatch(REG_WITH_AUTOPLAY, { targetSpins: 100 });
  expect(b).not.toBeNull();
  expect(b!.tile).toBe(100); // smallest preset >= 100
  expect(b!.actions[0]).toMatchObject({ kind: "click", uiKey: "autoButton" });
  expect(b!.actions.some((a) => a.kind === "click" && (a as { uiKey: string }).uiKey === "autoButton__autoCountSlide-100")).toBe(true);
  expect(b!.actions.some((a) => a.kind === "click" && (a as { uiKey: string }).uiKey === "autoButton__startAutoplayButton")).toBe(true);
  expect(b!.actions.at(-1)!.kind).toBe("wait_until_no_spin_response");
  expect(b!.actions.some((a) => a.kind === "spin")).toBe(false); // never discrete
});

test("buildAutoplayBatch falls back to highest tile when target exceeds all presets", () => {
  const b = buildAutoplayBatch(REG_WITH_AUTOPLAY, { targetSpins: 5000 });
  expect(b!.tile).toBe(1000); // highest available
});

test("buildAutoplayBatch returns null when no autoplay UI in registry", () => {
  const reg = { spinButton: el() } as unknown as UiRegistry;
  expect(buildAutoplayBatch(reg, { targetSpins: 100 })).toBeNull();
});

test("already-autoplay actions (no discrete spins) are left unchanged", () => {
  const actions: CaseAction[] = [
    { kind: "click", uiKey: "autoButton" },
    { kind: "click", uiKey: "autoButton__autoCountSlide-100" },
    { kind: "click", uiKey: "autoButton__startAutoplayButton" },
    { kind: "wait_until_no_spin_response", quietMs: 5000, maxMs: 180000 },
  ];
  const out = maybeConvertToAutoplay(actions, { category: "free_spins", spinCount: 100, uiMap: REG_WITH_AUTOPLAY });
  expect(out).toEqual(actions);
});
