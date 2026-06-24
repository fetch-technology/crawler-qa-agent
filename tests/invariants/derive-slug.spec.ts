// INVARIANT — deriveSlug always yields a path-safe, deletable slug.
//
// A loader URL (e.g. GPAS "…/gpasclient.html") used to fall through to the raw
// first path segment, producing the slug "gpasclient.html". That dotted slug
// was then UNDELETABLE — deleteGame's path-traversal guard rejected the dot, so
// the game was stuck in the registry. deriveSlug must never emit a slug that
// fails the delete guard.

import { test, expect } from "@playwright/test";
import { deriveSlug } from "../../src/pipeline/step1-crawl/crawler.ts";

// Mirror of deleteGame's accepted-slug rule (manual-session.ts).
const SLUG_SAFE = /^[a-zA-Z0-9_.-]+$/;
function isDeletable(slug: string): boolean {
  return SLUG_SAFE.test(slug) && !slug.includes("..") && !/^[.]+$/.test(slug) && /[a-zA-Z0-9]/.test(slug);
}

test("Pragmatic vs-style URL → clean slug", () => {
  expect(deriveSlug("https://sandbox.pragmaticlbv.com/vs243fortune/?t=abc_BRL")).toBe("vs243fortune");
});

test("3 Oaks games/<id>/play URL → game id slug", () => {
  expect(deriveSlug("https://host/api/v1/games/lucky_dragon/play/")).toBe("lucky_dragon");
});

test("GPAS loader 'gpasclient.html' → extension stripped, NOT 'gpasclient.html'", () => {
  const slug = deriveSlug("https://host/gpasclient.html?gameSymbol=foo&token=x");
  expect(slug).toBe("gpasclient");
  expect(slug).not.toContain(".html");
});

test("derived slugs are always deletable (path-safe, no dotted extension)", () => {
  const urls = [
    "https://host/gpasclient.html?x=1",
    "https://host/loader.php?game=y",
    "https://sandbox.pragmaticlbv.com/vs20daydead/?t=z_BRL",
    "https://host/api/v1/games/foo_game/play/",
    "https://host/some.weird.path.html",
  ];
  for (const u of urls) {
    const slug = deriveSlug(u);
    expect(isDeletable(slug), `slug "${slug}" from ${u} must be deletable`).toBe(true);
  }
});
