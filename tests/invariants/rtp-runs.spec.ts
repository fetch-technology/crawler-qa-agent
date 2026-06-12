// INVARIANT — RTP callback parsing. The RG event schema is NOT settled yet, so
// the parser must accept both JSON and the plain-text TAG/SERVICE/COMMAND
// block, extract match keys, and never throw on garbage (raw payload is always
// preserved verbatim in the inbox regardless).

import { test, expect } from "@playwright/test";
import { parseRtpEvent, DEFAULT_RTP_COMMAND } from "../../src/pipeline/server/rtp-runs.ts";

test("plain-text event block (client's example) parses TAG/SERVICE/COMMAND", () => {
  const raw = `TAG: v1.0.4.1
SERVICE: logic-vs20amuleteg-clonedpp
COMMAND: pnpm e2e --all --ec=volLevel=2&poolHitRate=[0.5,0.7]&hitRate=[0.5,0.7]&featureChance=1 --n=1M --ps=true
OUTPUT_URL: https://revengegames-logic-e2e.s3.ap-southeast-1.amazonaws.com/logic-vs20amuleteg-clonedpp/v1.0.4.1/2026-06-04-18-19-53-e2e-report.html`;
  const ev = parseRtpEvent(raw);
  expect(ev.tag).toBe("v1.0.4.1");
  expect(ev.service).toBe("logic-vs20amuleteg-clonedpp");
  expect(ev.command).toContain("--ps=true");
});

test("JSON event with lowercase keys parses too", () => {
  const ev = parseRtpEvent(JSON.stringify({
    tag: "v1.0.3.1",
    service: "logic-gpas-ssammct-pop-clonedpt",
    command: DEFAULT_RTP_COMMAND,
    output_url: "https://example.com/report.html",
  }));
  expect(ev.tag).toBe("v1.0.3.1");
  expect(ev.service).toBe("logic-gpas-ssammct-pop-clonedpt");
});

test("JSON event with logic_name alias maps to service", () => {
  const ev = parseRtpEvent(JSON.stringify({ TAG: "v2", logic_name: "logic-x-clonedpp" }));
  expect(ev.service).toBe("logic-x-clonedpp");
  expect(ev.tag).toBe("v2");
});

test("garbage payload → empty keys, no throw", () => {
  const ev = parseRtpEvent("hello world, no structure here");
  expect(ev.tag).toBeUndefined();
  expect(ev.service).toBeUndefined();
});
