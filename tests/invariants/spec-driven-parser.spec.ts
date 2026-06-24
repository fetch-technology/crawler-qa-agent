// INVARIANT — Spec-Driven Parser (Phase 9)
//
// Generic parser must:
//   - Match all URL patterns from spec
//   - Skip non-spin URLs
//   - Filter non-spin action bodies
//   - Compute bet from formula
//   - Build roundId from spec
//   - Score spin shape per spec
//   - Decode reels per decoder type
//
// Tests use minimal synthetic specs (no fixture files).

import { test, expect } from "@playwright/test";
import {
  SpecDrivenParser,
  parseBodyBySpec,
  scoreSpinShapeBySpec,
  decodeReelsBySpec,
  computeBetBySpec,
  buildRoundIdBySpec,
  applyNestedExtractions,
  mergeSpec,
} from "../../src/pipeline/step6-build-model/providers/spec-driven-parser.ts";
import { loadProviderSpec } from "../../src/pipeline/step6-build-model/providers/spec-loader.ts";
import type { ProviderSpec, ParserOverlay } from "../../src/pipeline/step6-build-model/providers/spec-types.ts";

function ppSpec(): ProviderSpec {
  return {
    name: "Pragmatic",
    wireFormat: "querystring",
    urlPatterns: ["/gs2c/.*gameservice"],
    skipUrlPatterns: ["/gs2c/saveSettings"],
    nonSpinActions: ["doInit"],
    spinRequiredParams: ["c"],
    response: {
      fields: {
        balanceBefore: "bb",
        balanceAfter: "ba",
        totalWin: "tw",
        initialReels: "s",
        cascadeFrames: "sa",
        freeSpinsRemaining: "fs",
        roundIndex: "index",
      },
      reelsDecoder: "column_major",
      defaultReelDimensions: { width: 5, height: 3 },
      shapeScore: {
        requiredFields: ["bb", "ba"],
        bonusFields: ["tw", "index", "sa"],
        minScore: 4,
      },
    },
    request: {
      fields: { coin: "c", betLevel: "bl", lines: "l", roundIdParts: ["index", "counter"] },
      betFormula: "coin * betLevel | coin * lines",
    },
    roundId: {
      source: "request",
      fields: ["index", "counter"],
      format: "req-{0}-{1}",
      fallback: "response_hash",
    },
  };
}

// === winBreakdown / serverTotalWin (Phase 0 — payout-integrity inputs) ===
// Regression: SpecDrivenParser used to leave winBreakdown=[] + serverTotalWin
// undefined, silently disabling every payout-integrity assertion on
// spec-driven games (the legacy PragmaticParser set both). Real frames below
// are from vswaysrsm (tumble ways game) — wlc_v itemization present.

test("SpecDrivenParser populates winBreakdown from wlc_v + serverTotalWin from tw", () => {
  const parser = new SpecDrivenParser(ppSpec(), "PragmaticParser");
  const res = "tw=0.04&wlc_v=12~0.04~1~3~6,8,19~l&na=s&rs=tumbling&bb=996049.2&ba=996048.8&index=1";
  const req = "action=doSpin&c=0.02&l=20&index=13&counter=4";
  const s = parser.parseSpinPair(req, res);
  expect(s.serverTotalWin).toBeCloseTo(0.04, 2);
  expect(s.winBreakdown).toHaveLength(1);
  expect(s.winBreakdown![0]!.symbol).toBe("12");
  expect(s.winBreakdown![0]!.win).toBeCloseTo(0.04, 2);
});

test("winBreakdown Σ-of-combos equals serverTotalWin (no phantom win)", () => {
  const parser = new SpecDrivenParser(ppSpec(), "PragmaticParser");
  // multi-combo frame: 0.16 + 0.20 = 0.36 itemized, tw cumulative 2.32
  const res = "tw=0.36&wlc_v=8~0.16~2~3~0,7,8,19~l;11~0.20~2~4~6,13,14,20,21~l&bb=996048.08&ba=996048.44&index=1";
  const s = parser.parseSpinPair("action=doSpin&c=0.02&l=20&index=22&counter=2", res);
  const sum = (s.winBreakdown ?? []).reduce((a, c) => a + c.win, 0);
  expect(s.winBreakdown).toHaveLength(2);
  expect(sum).toBeCloseTo(0.36, 2);
});

test("winItemization='none' opts out → winBreakdown empty (provider truly has no itemization)", () => {
  const spec = ppSpec();
  spec.response.winItemization = "none";
  const parser = new SpecDrivenParser(spec, "PragmaticParser");
  const res = "tw=0.04&wlc_v=12~0.04~1~3~6,8,19~l&bb=996049.2&ba=996048.8&index=1";
  const s = parser.parseSpinPair("action=doSpin&c=0.02&l=20&index=13&counter=4", res);
  expect(s.winBreakdown).toEqual([]);
});

test("non-winning frame → empty winBreakdown, serverTotalWin 0", () => {
  const parser = new SpecDrivenParser(ppSpec(), "PragmaticParser");
  const res = "tw=0.00&na=s&bb=996052&ba=996051.6&index=1";
  const s = parser.parseSpinPair("action=doSpin&c=0.02&l=20&index=30&counter=2", res);
  expect(s.winBreakdown).toEqual([]);
  expect(s.serverTotalWin).toBe(0);
});

// === per-game parser overlay (Phase 1 — base ⊕ overlay, trusted per-aspect) ===

test("mergeSpec: TRUSTED winItemization overrides base, base untouched", () => {
  const base = ppSpec();
  base.response.winItemization = "auto";
  const overlay: ParserOverlay = {
    schemaVersion: 1, basedOnProvider: "pragmatic",
    winItemization: { value: "cluster", trusted: true },
  };
  const merged = mergeSpec(base, overlay);
  expect(merged.response.winItemization).toBe("cluster");
  expect(base.response.winItemization).toBe("auto"); // base not mutated
  expect(merged).not.toBe(base);
});

test("mergeSpec: UNTRUSTED aspect is ignored → falls back to base", () => {
  const base = ppSpec();
  base.response.winItemization = "wlc_v";
  const overlay: ParserOverlay = {
    schemaVersion: 1, basedOnProvider: "pragmatic",
    winItemization: { value: "none", trusted: false }, // unverified guess
  };
  const merged = mergeSpec(base, overlay);
  expect(merged.response.winItemization).toBe("wlc_v"); // base wins
});

test("applySpecOverlay changes parse behavior: trusted 'none' → empty winBreakdown", () => {
  const parser = new SpecDrivenParser(ppSpec(), "PragmaticParser");
  const res = "tw=0.04&wlc_v=12~0.04~1~3~6,8,19~l&bb=996049.2&ba=996048.8&index=1";
  const req = "action=doSpin&c=0.02&l=20&index=13&counter=4";
  // before overlay: default (auto/wlc_v) → itemized
  expect(parser.parseSpinPair(req, res).winBreakdown).toHaveLength(1);
  // apply trusted overlay forcing "none" → opts out
  parser.applySpecOverlay({
    schemaVersion: 1, basedOnProvider: "pragmatic",
    winItemization: { value: "none", trusted: true },
  });
  expect(parser.parseSpinPair(req, res).winBreakdown).toEqual([]);
});

test("applySpecOverlay(null) is a no-op", () => {
  const parser = new SpecDrivenParser(ppSpec(), "PragmaticParser");
  const before = parser.spec.response.winItemization;
  parser.applySpecOverlay(null);
  expect(parser.spec.response.winItemization).toBe(before);
});

// === parseBodyBySpec ===

test("querystring wire format parses urlencoded body", () => {
  const r = parseBodyBySpec("a=1&b=hello&c=", "querystring");
  expect(r).toEqual({ a: "1", b: "hello", c: "" });
});

test("json wire format parses JSON body", () => {
  const r = parseBodyBySpec('{"a":1,"b":"x"}', "json");
  expect(r).toEqual({ a: 1, b: "x" });
});

test("auto wire format detects JSON first", () => {
  const r = parseBodyBySpec('{"foo":42}', "auto");
  expect(r).toEqual({ foo: 42 });
});

test("auto wire format falls back to querystring", () => {
  const r = parseBodyBySpec("foo=42&bar=x", "auto");
  expect(r).toEqual({ foo: "42", bar: "x" });
});

test("empty body → null", () => {
  expect(parseBodyBySpec("", "querystring")).toBe(null);
});

// === scoreSpinShapeBySpec ===

test("score: all required + bonus present → high score", () => {
  const r = scoreSpinShapeBySpec(
    { bb: 100, ba: 90, tw: 0, index: 5, sa: "abc" },
    { requiredFields: ["bb", "ba"], bonusFields: ["tw", "index", "sa"], minScore: 4 },
  );
  expect(r.score).toBe(5); // 2 required (+2) + 3 bonus (+3)
});

test("score: missing required field → negative score component", () => {
  const r = scoreSpinShapeBySpec(
    { ba: 90 },
    { requiredFields: ["bb", "ba"], minScore: 2 },
  );
  expect(r.score).toBe(0); // +1 (ba) - 1 (bb missing)
});

test("score: empty body → 0 score", () => {
  const r = scoreSpinShapeBySpec(null, { requiredFields: ["x"], minScore: 1 });
  expect(r.score).toBe(0);
});

// === decodeReelsBySpec ===

test("column_major decode 6-char string into 2x3", () => {
  const r = decodeReelsBySpec("ABCDEF", "column_major", 2, 3);
  expect(r).toEqual([["A", "B", "C"], ["D", "E", "F"]]);
});

test("decoder returns [] for wrong length input", () => {
  const r = decodeReelsBySpec("ABCD", "column_major", 2, 3);
  expect(r).toEqual([]);
});

test("json_array decoder passes through arrays", () => {
  const r = decodeReelsBySpec([["A", "B"], ["C", "D"]], "json_array", 2, 2);
  expect(r).toEqual([["A", "B"], ["C", "D"]]);
});

test("csv decoder splits comma + newline", () => {
  const r = decodeReelsBySpec("A,B,C\nD,E,F", "csv", 3, 2);
  expect(r).toEqual([["A", "B", "C"], ["D", "E", "F"]]);
});

// === computeBetBySpec ===

test("bet = coin * betLevel", () => {
  const b = computeBetBySpec(
    { c: 0.5, bl: 20, l: 0 },
    { fields: { coin: "c", betLevel: "bl", lines: "l" }, betFormula: "coin * betLevel | coin * lines" },
  );
  expect(b).toBe(10);
});

test("bet fallback to coin * lines when bl missing", () => {
  const b = computeBetBySpec(
    { c: 0.5, l: 20 },
    { fields: { coin: "c", betLevel: "bl", lines: "l" }, betFormula: "coin * betLevel | coin * lines" },
  );
  expect(b).toBe(10);
});

test("explicit betMultiplier override wins", () => {
  const b = computeBetBySpec(
    { c: 0.45, bl: 0, l: 1024 },
    { fields: { coin: "c", betLevel: "bl", lines: "l" }, betFormula: "coin * lines" },
    20, // multiplier from game-mechanics
  );
  expect(b).toBe(9); // 0.45 × 20 (NOT 0.45 × 1024 = 460.8)
});

test("fixed multiplier formula `coin * fixed:20`", () => {
  const b = computeBetBySpec(
    { c: 0.45 },
    { fields: { coin: "c" }, betFormula: "coin * fixed:20" },
  );
  expect(b).toBe(9);
});

test("explicit bet field", () => {
  const b = computeBetBySpec(
    { bet: 25 },
    { fields: { explicitBet: "bet" }, betFormula: "explicit" },
  );
  expect(b).toBe(25);
});

// === buildRoundIdBySpec ===

test("buildRoundId from request with format", () => {
  const id = buildRoundIdBySpec(
    { index: 5, counter: 2 },
    { ba: 90 },
    { source: "request", fields: ["index", "counter"], format: "req-{0}-{1}" },
  );
  expect(id).toBe("req-5-2");
});

test("buildRoundId fallback to response_hash when source missing", () => {
  const id = buildRoundIdBySpec(
    null,
    { ba: 90, sa: "xyz" },
    { source: "request", fields: ["index"], fallback: "response_hash" },
  );
  expect(id).toMatch(/^hash-/);
});

// === SpecDrivenParser end-to-end ===

test("SpecDrivenParser canParseResponse accepts matching PP URL", () => {
  const parser = new SpecDrivenParser(ppSpec());
  const res = "bb=100&ba=90&tw=0&index=1&sa=ABCDEFGHIJKLMNO";
  const url = "https://example.com/gs2c/v3/gameservice";
  expect(parser.canParseResponse(res, url)).toBe(true);
});

test("SpecDrivenParser canParseResponse rejects non-PP URL", () => {
  const parser = new SpecDrivenParser(ppSpec());
  expect(parser.canParseResponse("bb=100&ba=90", "https://elsewhere.example")).toBe(false);
});

test("SpecDrivenParser canParseResponse rejects body with doInit action", () => {
  const parser = new SpecDrivenParser(ppSpec());
  const res = "a=doInit&bb=100&ba=100";
  const url = "https://example.com/gs2c/v3/gameservice";
  expect(parser.canParseResponse(res, url)).toBe(false);
});

test("SpecDrivenParser parseSpinPair: PP-style request + response", () => {
  const parser = new SpecDrivenParser(ppSpec());
  const req = "a=doSpin&c=0.5&bl=20&l=20&index=7&counter=3";
  const res = "bb=100&ba=90&tw=0&index=7&sa=ABCDEFGHIJKLMNO";
  const r = parser.parseSpinPair(req, res, "https://example.com/gs2c/v3/gameservice");
  expect(r.roundId).toBe("req-7-3");
  expect(r.bet).toBe(10); // 0.5 × 20
  expect(r.balanceBefore).toBe(100);
  expect(r.balanceAfter).toBe(90);
  expect(r.win).toBe(0);
});

test("SpecDrivenParser setBetMultiplier override", () => {
  const parser = new SpecDrivenParser(ppSpec());
  parser.setBetMultiplier(20);
  const req = "a=doSpin&c=0.45&bl=0&l=1024&index=1&counter=1";
  const res = "bb=100&ba=91&tw=0&index=1&sa=ABCDEFGHIJKLMNO";
  const r = parser.parseSpinPair(req, res, "https://example.com/gs2c/v3/gameservice");
  expect(r.bet).toBe(9); // 0.45 × 20
});

test("SpecDrivenParser deterministic (same input → same result)", () => {
  const parser = new SpecDrivenParser(ppSpec());
  const req = "a=doSpin&c=0.5&bl=20&index=1&counter=1";
  const res = "bb=100&ba=90&tw=0&index=1&sa=ABCDEFGHIJKLMNO";
  const url = "https://example.com/gs2c/v3/gameservice";
  const r1 = parser.parseSpinPair(req, res, url);
  const r2 = parser.parseSpinPair(req, res, url);
  expect(r1).toEqual(r2);
});

test("SpecDrivenParser exposes kind + providerCode", () => {
  const parser = new SpecDrivenParser(ppSpec(), "PragmaticParser");
  expect(parser.kind).toBe("PragmaticParser");
  expect(parser.providerCode).toBe("PRAG");
});

// === Real pragmatic.json round-trip ===

test("loadProviderSpec('pragmatic') returns valid spec", async () => {
  const spec = await loadProviderSpec("pragmatic");
  expect(spec.name).toBe("Pragmatic");
  expect(spec.wireFormat).toBe("querystring");
  // balanceAfter is a pipe-separated alias list — newer PP variants emit
  // `balance` or `balance_cash`, older ones emit `ba`. Parser tries each.
  expect(spec.response.fields.balanceAfter?.split("|")).toContain("ba");
  expect(spec.response.fields.balanceAfter?.split("|")).toContain("balance");
  expect(spec.request.fields.coin).toBe("c");
});

test("SpecDrivenParser loaded from disk parses vs20rnriches-style sample", async () => {
  const spec = await loadProviderSpec("pragmatic");
  const parser = new SpecDrivenParser(spec);
  const req = "a=doSpin&c=0.5&bl=20&l=20&index=8&counter=2";
  const res = "bb=100&ba=90&tw=0&sa=ABCDEFGHIJKLMNO&index=8&na=s";
  const r = parser.parseSpinPair(req, res, "https://pp.example.com/gs2c/v3/gameService");
  expect(r.bet).toBe(10);
  expect(r.balanceAfter).toBe(90);
  expect(r.roundId).toBe("req-8-2");
});

// === nestedExtractions ===

test("applyNestedExtractions: extracts s from g={gp:{s:\"...\"}} blob", () => {
  const parsed: Record<string, unknown> = {
    g: 'gp:{s:"1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25",sw:5,sh:5}',
  };
  applyNestedExtractions(parsed, [
    { sourceField: "g", pattern: 'gp:\\{[^}]*?\\bs:"([^"]+)"', targetField: "s" },
  ]);
  expect(parsed.s).toBe("1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25");
});

test("applyNestedExtractions: existing target field NOT overwritten", () => {
  const parsed: Record<string, unknown> = {
    g: 'gp:{s:"X,Y,Z"}',
    s: "TOP_LEVEL_WINS",
  };
  applyNestedExtractions(parsed, [
    { sourceField: "g", pattern: 'gp:\\{s:"([^"]+)"', targetField: "s" },
  ]);
  expect(parsed.s).toBe("TOP_LEVEL_WINS");
});

test("applyNestedExtractions: missing source field is no-op", () => {
  const parsed: Record<string, unknown> = { tw: "0" };
  applyNestedExtractions(parsed, [
    { sourceField: "g", pattern: 'gp:\\{s:"([^"]+)"', targetField: "s" },
  ]);
  expect(parsed.s).toBeUndefined();
});

test("applyNestedExtractions: invalid regex skipped silently", () => {
  const parsed: Record<string, unknown> = { g: "anything" };
  applyNestedExtractions(parsed, [
    { sourceField: "g", pattern: "[unclosed-bracket", targetField: "s" },
  ]);
  expect(parsed.s).toBeUndefined();
});

test("applyNestedExtractions: undefined extraction list is no-op", () => {
  const parsed: Record<string, unknown> = { g: 'gp:{s:"X"}' };
  applyNestedExtractions(parsed, undefined);
  expect(parsed.s).toBeUndefined();
});

test("SpecDrivenParser end-to-end: nested s extracted, reels populated", () => {
  const spec = ppSpec();
  spec.response.nestedExtractions = [
    { sourceField: "g", pattern: 'gp:\\{[^}]*?\\bs:"([^"]+)"', targetField: "s" },
  ];
  spec.response.shapeScore = { requiredFields: ["na", "tw"], bonusFields: ["c", "sw", "sh", "s"], minScore: 3 };
  spec.response.fields.initialReels = "s";
  spec.response.defaultReelDimensions = { width: 5, height: 5 };
  const parser = new SpecDrivenParser(spec);
  const req = "a=doSpin&c=0.5&bl=20&l=20&index=1&counter=1";
  // 25-char s via column_major decoder (5x5)
  const res = 'na=s&tw=0&c=0.50&sw=5&sh=5&g=gp:{s:"ABCDEFGHIJKLMNOPQRSTUVWXY",sw:5,sh:5}';
  const r = parser.parseSpinPair(req, res, "https://pp.example.com/gs2c/v3/gameService");
  expect(r.reels.length).toBe(5);
  expect(r.reels[0]?.length).toBe(5);
  expect(r.reels[0]?.[0]).toBe("A");
});

test("decodeReelsBySpec: comma-separated multi-digit symbols column-major", () => {
  // 5x5 grid of numeric symbol IDs (PP newer-format style: "13,13,13,1,2,...")
  const raw = "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25";
  const reels = decodeReelsBySpec(raw, "column_major", 5, 5);
  expect(reels.length).toBe(5);
  expect(reels[0]).toEqual(["1", "2", "3", "4", "5"]);
  expect(reels[4]).toEqual(["21", "22", "23", "24", "25"]);
});

test("decodeReelsBySpec: comma-separated rejects wrong dimension", () => {
  // 24 tokens, expected 25 (5x5) — must reject, return []
  const raw = "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24";
  const reels = decodeReelsBySpec(raw, "column_major", 5, 5);
  expect(reels).toEqual([]);
});

test("decodeReelsBySpec: single-char string still works (backward compat)", () => {
  // Classic PP format: 15-char string for 5x3 grid
  const raw = "ABCDEFGHIJKLMNO";
  const reels = decodeReelsBySpec(raw, "column_major", 5, 3);
  expect(reels.length).toBe(5);
  expect(reels[0]).toEqual(["A", "B", "C"]);
});

// === roundEndSignals (Phase 10.x — adaptive runner) ===

test("ProviderSpec accepts roundEndSignals field", async () => {
  const spec = await loadProviderSpec("pragmatic");
  expect(Array.isArray(spec.roundEndSignals)).toBe(true);
  expect(spec.roundEndSignals?.length).toBeGreaterThanOrEqual(1);
  const first = spec.roundEndSignals?.[0];
  expect(first?.urlPattern).toMatch(/gameservice/i);
  expect(first?.bodyPattern).toMatch(/doCollect/);
});

test("PP roundEndSignal regex matches actual doCollect URL+body pair", async () => {
  const spec = await loadProviderSpec("pragmatic");
  const sig = spec.roundEndSignals![0];
  const url = "https://pp.dev.revenge-games.com/gs2c/v3/gameService";
  const reqBody = "symbol=vswaysmahwin2&action=doCollect&index=6&counter=2&repeat=0&mgckey=demo@SFT";
  expect(new RegExp(sig.urlPattern, "i").test(url)).toBe(true);
  expect(new RegExp(sig.bodyPattern!, "i").test(reqBody)).toBe(true);
});

test("PP roundEndSignal does NOT match regular doSpin request", async () => {
  const spec = await loadProviderSpec("pragmatic");
  const sig = spec.roundEndSignals![0];
  const reqBody = "action=doSpin&symbol=vswaysmahwin2&c=0.01&l=1024&sInfo=n&bl=0&index=2&counter=3";
  // URL matches but body should NOT match (action=doSpin, not doCollect)
  expect(new RegExp(sig.bodyPattern!, "i").test(reqBody)).toBe(false);
});

// LAYER 3 — declarative free-spin signal (clones that don't use top-level fs=N).
// vs20daydead packs state in `trail=mode~free;...;fs~N`.
function ppSpecWithSignal(): ProviderSpec {
  const s = ppSpec();
  s.response.freeSpinSignal = { field: "trail", contains: "mode~free" };
  return s;
}

test("freeSpinSignal (trail contains mode~free) + flat balance → FREE_SPIN, bet 0", () => {
  const p = new SpecDrivenParser(ppSpecWithSignal(), "PragmaticParser");
  const url = "https://x/gs2c/v3/gameService";
  // No top-level fs; FS state only in trail. Balance flat (no deduction).
  const body = "bb=960&ba=960&tw=0&index=1&trail=mode~free;wild_bar~1;fs~1&s=1,2,3";
  const spin = p.parseResponse(body);
  expect(spin.state).toBe("FREE_SPIN");
  expect(spin.isFreeSpin).toBe(true);
  expect(spin.bet).toBe(0);
});

test("BUY frame carries the same token but DEDUCTS → stays NORMAL (balance guard)", () => {
  const p = new SpecDrivenParser(ppSpecWithSignal(), "PragmaticParser");
  // trail has the FS token, but the wallet dropped 40 (the buy cost).
  const body = "bb=1000&ba=960&tw=0&index=1&trail=mode~base;markers~fs_trig&s=1,2,3";
  const spin = p.parseResponse(body);
  expect(spin.state).toBe("NORMAL"); // mode~base anyway; guard also catches drops
  const body2 = "bb=1000&ba=960&tw=0&index=1&trail=mode~free;fs~1&s=1,2,3";
  expect(p.parseResponse(body2).state).toBe("NORMAL"); // token present but deducted
});

test("nestedExtractions pulls fs~N out of trail into freeSpinsRemaining", () => {
  const s = ppSpec();
  s.response.nestedExtractions = [{ sourceField: "trail", pattern: "fs~(\\d+)", targetField: "fs" }];
  const p = new SpecDrivenParser(s, "PragmaticParser");
  const body = "bb=960&ba=960&tw=0&index=1&trail=mode~free;wild_bar~1;fs~3&s=1,2,3";
  const spin = p.parseResponse(body);
  expect(spin.freeSpinsRemaining).toBe(3);
  expect(spin.state).toBe("FREE_SPIN");
});

test("mergeSpec propagates trusted freeSpinSignal + nestedExtractions from overlay", () => {
  const base = ppSpec();
  const overlay: ParserOverlay = {
    schemaVersion: 1,
    basedOnProvider: "pragmatic",
    freeSpinSignal: { value: { field: "trail", contains: "mode~free" }, trusted: true },
    nestedExtractions: { value: [{ sourceField: "trail", pattern: "fs~(\\d+)", targetField: "fs" }], trusted: true },
  };
  const merged = mergeSpec(base, overlay);
  expect(merged.response.freeSpinSignal).toEqual({ field: "trail", contains: "mode~free" });
  expect(merged.response.nestedExtractions?.some((e) => e.targetField === "fs")).toBe(true);
});

test("mergeSpec DROPS an untrusted freeSpinSignal (fail-loud fallback to base)", () => {
  const base = ppSpec();
  const overlay: ParserOverlay = {
    schemaVersion: 1,
    basedOnProvider: "pragmatic",
    freeSpinSignal: { value: { field: "trail", contains: "mode~free" }, trusted: false },
  };
  const merged = mergeSpec(base, overlay);
  expect(merged.response.freeSpinSignal).toBeUndefined();
});
