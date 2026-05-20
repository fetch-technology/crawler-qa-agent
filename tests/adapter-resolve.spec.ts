/**
 * Smoke test cho adapter layer.
 *
 * Verify:
 *   1. `resolveAdapter()` always returns something usable.
 *   2. Known PP slugs compose to PP × Ways adapter.
 *   3. Adapter can parse a real recorded spin response from fixtures.
 *   4. Adapter.shouldMockRoute() correctly identifies PP non-spin requests.
 */

import { test, expect } from "@playwright/test";
import {
  bootstrapAdapters,
  resolveAdapter,
} from "../src/adapters/index.js";
import { loadScenario, listScenarios } from "../src/runner/scenario.js";

bootstrapAdapters();

test("resolveAdapter returns generic fallback for unknown slug", () => {
  const adapter = resolveAdapter({ slug: "definitely-not-a-real-game" });
  expect(adapter.gameCode).toBe("definitely-not-a-real-game");
  expect(adapter.providerCode).toBe("GENERIC");
  expect(adapter.mechanicCode).toBe("ways");
});

test("resolveAdapter sniffs PP from gs2c URL", () => {
  const adapter = resolveAdapter({
    slug: "fiesta-magenta",
    sampleUrl: "https://demogamesfree.pragmaticplay.net/gs2c/v3/gameService",
  });
  expect(adapter.providerCode).toBe("PP");
  expect(adapter.mechanicCode).toBe("ways");
});

test("PP adapter parses a real scenario body", () => {
  const labels = listScenarios("fiesta-magenta");
  if (labels.length === 0) {
    test.skip();
    return;
  }
  const scenario = loadScenario("fiesta-magenta", labels[0]!);
  const adapter = resolveAdapter({
    slug: "fiesta-magenta",
    sampleUrl: scenario.spin_response.url,
  });
  const parsed = adapter.parseResponse(scenario.spin_response.body);
  expect(parsed.raw).toBeTruthy();
  expect(parsed.width).toBeGreaterThan(0);
  expect(parsed.height).toBeGreaterThan(0);
  expect(Number.isFinite(parsed.win)).toBe(true);
  expect(Number.isFinite(parsed.balanceAfter)).toBe(true);
});

test("PP shouldMockRoute returns false for doInit", () => {
  const adapter = resolveAdapter({
    slug: "fiesta-magenta",
    sampleUrl: "https://demogamesfree.pragmaticplay.net/gs2c/v3/gameService",
  });
  expect(adapter.shouldMockRoute).toBeDefined();
  const decision = adapter.shouldMockRoute!({
    url: "https://demogamesfree.pragmaticplay.net/gs2c/v3/gameService",
    method: "POST",
    postData: "a=doInit&symbol=fiestamagenta",
  });
  expect(decision).toBe(false);
});

test("PP shouldMockRoute returns true for doSpin with c+bl", () => {
  const adapter = resolveAdapter({
    slug: "fiesta-magenta",
    sampleUrl: "https://demogamesfree.pragmaticplay.net/gs2c/v3/gameService",
  });
  expect(adapter.shouldMockRoute).toBeDefined();
  const decision = adapter.shouldMockRoute!({
    url: "https://demogamesfree.pragmaticplay.net/gs2c/v3/gameService",
    method: "POST",
    postData: "a=doSpin&c=0.04&bl=20&l=20&symbol=fiestamagenta",
  });
  expect(decision).toBe(true);
});

test("PP shouldMockRoute returns undefined for non-PP URL", () => {
  const adapter = resolveAdapter({
    slug: "fiesta-magenta",
    sampleUrl: "https://demogamesfree.pragmaticplay.net/gs2c/v3/gameService",
  });
  expect(adapter.shouldMockRoute).toBeDefined();
  const decision = adapter.shouldMockRoute!({
    url: "https://other-provider.com/api/spin",
    method: "POST",
    postData: null,
  });
  expect(decision).toBeUndefined();
});

test("Generic adapter detectSpinResponse on PP body", () => {
  const adapter = resolveAdapter({ slug: "generic-game" });
  const body = "tw=0.32&balance=999986.47&s=eaihhbeffbafgah&sw=5&sh=3&c=0.04&l=25&w=0";
  expect(adapter.detectSpinResponse(body)).toBe(true);
});
