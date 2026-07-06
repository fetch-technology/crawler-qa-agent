import { test, expect } from "@playwright/test";
import { formatRegistryHierarchy } from "../../src/pipeline/registry/hierarchy.ts";
import type { UiRegistry } from "../../src/pipeline/registry/types.ts";

test("registry hierarchy marks hold-preferred elements for action translation", () => {
  const reg = {
    spinButton: {
      x: 100,
      y: 200,
      strategy: "manual",
      confidence: 1,
      detectedAt: "2026-07-03T00:00:00.000Z",
      status: "verified",
      preferredGesture: "hold",
      preferredHoldMs: 5000,
    },
  } satisfies UiRegistry;

  expect(formatRegistryHierarchy(reg)).toContain("[hold 5000ms]");
});
