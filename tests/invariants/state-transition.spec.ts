// INVARIANT — state transition graph
//
// The state machine in src/pipeline/step6-build-model/state-machine.ts
// defines which transitions are valid between spin states. Engine relies on
// this for free-spin tracking, bonus completion detection, etc. Tests
// codify the transition graph so future changes can't silently break it.

import { test, expect } from "@playwright/test";
import { isValidTransition, validTransitionsFrom } from "../../src/pipeline/step6-build-model/state-machine.ts";

// === Whitelisted transitions ===

test("NORMAL → NORMAL is valid (every regular spin)", () => {
  expect(isValidTransition("NORMAL", "NORMAL")).toBe(true);
});

test("NORMAL → FREE_SPIN is valid (trigger free spins)", () => {
  expect(isValidTransition("NORMAL", "FREE_SPIN")).toBe(true);
});

test("NORMAL → BONUS is valid", () => {
  expect(isValidTransition("NORMAL", "BONUS")).toBe(true);
});

test("NORMAL → GAMBLE is valid", () => {
  expect(isValidTransition("NORMAL", "GAMBLE")).toBe(true);
});

test("FREE_SPIN → FREE_SPIN is valid (consecutive free spins)", () => {
  expect(isValidTransition("FREE_SPIN", "FREE_SPIN")).toBe(true);
});

test("FREE_SPIN → RETRIGGER is valid", () => {
  expect(isValidTransition("FREE_SPIN", "RETRIGGER")).toBe(true);
});

test("FREE_SPIN → END_BONUS is valid (free spins complete)", () => {
  expect(isValidTransition("FREE_SPIN", "END_BONUS")).toBe(true);
});

test("RETRIGGER → FREE_SPIN is valid", () => {
  expect(isValidTransition("RETRIGGER", "FREE_SPIN")).toBe(true);
});

test("END_BONUS → NORMAL is valid (return to base game)", () => {
  expect(isValidTransition("END_BONUS", "NORMAL")).toBe(true);
});

test("GAMBLE → NORMAL is valid (gamble resolved)", () => {
  expect(isValidTransition("GAMBLE", "NORMAL")).toBe(true);
});

// === Illegal transitions ===

test("FREE_SPIN → NORMAL (without END_BONUS) is INVALID", () => {
  expect(isValidTransition("FREE_SPIN", "NORMAL")).toBe(false);
});

test("FREE_SPIN → BONUS is INVALID (no bonus chain within free spin)", () => {
  expect(isValidTransition("FREE_SPIN", "BONUS")).toBe(false);
});

test("FREE_SPIN → GAMBLE is INVALID", () => {
  expect(isValidTransition("FREE_SPIN", "GAMBLE")).toBe(false);
});

test("GAMBLE → FREE_SPIN is INVALID", () => {
  expect(isValidTransition("GAMBLE", "FREE_SPIN")).toBe(false);
});

test("BONUS → NORMAL skipping END_BONUS is INVALID", () => {
  expect(isValidTransition("BONUS", "NORMAL")).toBe(false);
});

test("END_BONUS → FREE_SPIN is INVALID (must go through NORMAL)", () => {
  expect(isValidTransition("END_BONUS", "FREE_SPIN")).toBe(false);
});

test("RETRIGGER → NORMAL is INVALID", () => {
  expect(isValidTransition("RETRIGGER", "NORMAL")).toBe(false);
});

// === Graph completeness ===

test("validTransitionsFrom returns array for every known state", () => {
  for (const state of ["NORMAL", "FREE_SPIN", "BONUS", "GAMBLE", "RETRIGGER", "END_BONUS"] as const) {
    const next = validTransitionsFrom(state);
    expect(Array.isArray(next)).toBe(true);
    expect(next.length).toBeGreaterThan(0);
  }
});

test("All transitions are self-consistent (validTransitionsFrom == isValidTransition)", () => {
  for (const from of ["NORMAL", "FREE_SPIN", "BONUS", "GAMBLE", "RETRIGGER", "END_BONUS"] as const) {
    for (const to of validTransitionsFrom(from)) {
      expect(isValidTransition(from, to)).toBe(true);
    }
  }
});

// === Realistic sequences ===

test("realistic sequence: 5 normal spins → trigger → 10 free spins → end", () => {
  // Walk through a complete free-spin chain
  const sequence: ("NORMAL" | "FREE_SPIN" | "END_BONUS")[] = [
    "NORMAL", "NORMAL", "NORMAL", "NORMAL", "NORMAL", // base game
    "FREE_SPIN", "FREE_SPIN", "FREE_SPIN", "FREE_SPIN", "FREE_SPIN", // free spins
    "END_BONUS", "NORMAL", // back to base
  ];
  for (let i = 1; i < sequence.length; i++) {
    expect(isValidTransition(sequence[i - 1]!, sequence[i]!)).toBe(true);
  }
});

test("realistic sequence: free spin with retrigger", () => {
  const sequence: ("NORMAL" | "FREE_SPIN" | "RETRIGGER" | "END_BONUS")[] = [
    "NORMAL", "FREE_SPIN", "FREE_SPIN", "RETRIGGER", "FREE_SPIN", "FREE_SPIN", "END_BONUS", "NORMAL",
  ];
  for (let i = 1; i < sequence.length; i++) {
    expect(isValidTransition(sequence[i - 1]!, sequence[i]!)).toBe(true);
  }
});
