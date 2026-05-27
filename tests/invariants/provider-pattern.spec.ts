// INVARIANT — Pragmatic provider URL patterns recognize all PP families
//
// vswaysmahwin2 was mis-classified as "Generic" before 2026-05-25 because
// the regex `vs\d+\w+` required digits right after "vs". Real PP slugs use
// vsways<name>, vscluster<name>, etc. Without this fix, parser.json was
// saved as "GenericParser" → bet always parsed as 0 for ways games.

import { test, expect } from "@playwright/test";
import { resolveProviderPattern } from "../../src/pipeline/registry/provider-config.ts";

test("Pragmatic pattern matches classic numbered slugs (vs20rnriches)", async () => {
  const re = await resolveProviderPattern("Pragmatic");
  expect(re.test("https://pp.dev.revenge-games.com/vs20rnriches/?t=...")).toBe(true);
  expect(re.test("https://demo.pragmaticplay.net/gs2c/v3/gameService?game=vs10aocelot")).toBe(true);
});

test("Pragmatic pattern matches ways family (REGRESSION for vswaysmahwin2)", async () => {
  const re = await resolveProviderPattern("Pragmatic");
  expect(re.test("https://pp.dev.revenge-games.com/vswaysmahwin2/?t=...")).toBe(true);
  expect(re.test("https://pp.dev.revenge-games.com/vswaysrcandy/")).toBe(true);
});

test("Pragmatic pattern matches cluster family (vscluster*)", async () => {
  const re = await resolveProviderPattern("Pragmatic");
  expect(re.test("https://demo.com/vsclustertumbl/")).toBe(true);
});

test("Pragmatic pattern matches by host (//pp. prefix) even when path is non-canonical", async () => {
  const re = await resolveProviderPattern("Pragmatic");
  expect(re.test("https://pp.dev.revenge-games.com/lobby?game=foo")).toBe(true);
});

test("Pragmatic pattern matches gs2c URL fragment", async () => {
  const re = await resolveProviderPattern("Pragmatic");
  expect(re.test("https://x.example.com/gs2c/v3/gameService")).toBe(true);
});

test("Pragmatic pattern does NOT match generic non-PP URLs", async () => {
  const re = await resolveProviderPattern("Pragmatic");
  expect(re.test("https://example.com/game/zeus-lightning")).toBe(false);
  expect(re.test("https://jili.example.com/spin")).toBe(false);
});
