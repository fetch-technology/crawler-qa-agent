// INVARIANT — ocrRegion exposes imageBuf alongside text
//
// 2026-05-25 evidence-pkg: case-executor persists the bbox crop as PNG so
// the dashboard "OCR Evidence" panel can render inline thumbnails. Verify
// the return type contract — text + durationMs + imageBuf all present.
//
// Note: we don't actually drive Playwright here — invoking ocrRegion
// requires a live Page. We verify the type shape compiles + the function
// is exported with the expected signature.

import { test, expect } from "@playwright/test";
import { ocrRegion } from "../../src/pipeline/utils/ocr-popup.ts";

test("ocrRegion: exported and callable with region object", () => {
  // Static type check via TypeScript: the function exists and takes the
  // expected (page, region) signature. Calling without Page would crash, so
  // we just verify the function identity.
  expect(typeof ocrRegion).toBe("function");
  expect(ocrRegion.length).toBeGreaterThanOrEqual(2); // page + region params
});

test("ocrRegion: return type includes imageBuf (verified at compile time)", () => {
  // This test exists primarily as a TypeScript contract check. If
  // ocrRegion's return type drops imageBuf, this file fails to compile.
  // The runtime assertion is trivial — the structural test is the import +
  // (in another spec) the case-executor consumer that reads .imageBuf.
  type OcrReturn = Awaited<ReturnType<typeof ocrRegion>>;
  const sample: OcrReturn = {
    text: "$1.50",
    durationMs: 100,
    imageBuf: Buffer.from(""),
  };
  expect(sample.text).toBe("$1.50");
  expect(Buffer.isBuffer(sample.imageBuf)).toBe(true);
});
