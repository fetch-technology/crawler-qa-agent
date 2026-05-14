/**
 * Phân loại error message + sinh giải thích plain-English + gợi ý debug.
 * Dùng chung cho live runner (case-reporter), case-report.ts, và UI dashboard.
 */

export type ErrorCategory =
  | "code_bug"            // TypeError, ReferenceError, undefined access
  | "assertion_failure"   // expect().toBeTruthy() / .toBe() returned false
  | "setup_failure"       // applyCaseSetup achieved=false
  | "runtime_timeout"     // doAutoSpin / waitForFeatureComplete / waitForAutoplayRounds threw
  | "playwright_timeout"  // Test timeout of Xms exceeded
  | "auto_skip"           // Playwright auto-skipped (serial mode / --grep)
  | "ai_error"            // AI api call failed
  | "network_error"       // Spin endpoint not reachable / response missing
  | "unknown";

export type CategorizedError = {
  category: ErrorCategory;
  title: string;          // 1-line label cho UI badge
  summary: string;        // 1-2 sentence plain English explanation
  suggestion: string;     // 1-2 sentence — what to check / how to debug
  location?: string;      // file:line if extractable from stack
};

export function categorizeError(
  errorMessage: string | undefined | null,
  errorStack?: string | null,
): CategorizedError {
  const e = (errorMessage ?? "").trim();
  const s = (errorStack ?? "").trim();
  const eLower = e.toLowerCase();

  const location = extractLocation(s);

  // 1. AUTO-SKIP (Playwright skipped without explicit reason)
  if (
    eLower.startsWith("auto-skipped by playwright") ||
    eLower.startsWith("test was skipped (no reason")
  ) {
    return {
      category: "auto_skip",
      title: "Auto-skipped",
      summary: "Playwright skipped this test without an explicit reason — usually caused by --grep filter or a previous test failing in serial mode.",
      suggestion: "Click ▶ Run on this case to execute it independently. If still skipped, check if test.skip is being called somewhere unconditionally.",
      location,
    };
  }

  // 2. SETUP FAILURE (test.skip(true, "[setup failed: max_iter] ..."))
  const setupMatch = e.match(/\[setup failed:\s*([\w_]+)\]/i);
  if (setupMatch) {
    const reason = setupMatch[1];
    const reasonExplain: Record<string, string> = {
      max_iter: "Setup AI hit the iteration limit without confirming the goal.",
      stuck: "Setup AI saw the same UI state 4× in a row (UI not responding to clicks).",
      wait_exhausted: "Setup AI saw 5 consecutive 'wait' decisions (UI loading too long).",
      ai_error: "Claude API call failed during setup.",
    };
    return {
      category: "setup_failure",
      title: `Setup failed (${reason})`,
      summary: reasonExplain[reason ?? ""] ?? `Setup driver returned reason='${reason}' before reaching the goal.`,
      suggestion: "Open the case's Screenshots panel — the last setup screenshot shows what UI state setup gave up on. Refine setup_instructions to match real UI flow, or set SETUP_MAX_ITERATIONS higher.",
      location,
    };
  }

  // 3. PLAYWRIGHT TIMEOUT (whole test exceeded test.setTimeout)
  if (/^test timeout of \d+ms exceeded/i.test(e)) {
    const match = e.match(/(\d+)ms/);
    const ms = match ? Number(match[1]) : 0;
    return {
      category: "playwright_timeout",
      title: "Test timeout exceeded",
      summary: `Whole test took longer than the ${ms ? Math.round(ms / 1000) : "?"}s timeout. Often happens when AI loops on slow operations (autoplay 25 spins × ~25s each = 10+ min).`,
      suggestion: "Use waitForAutoplayRounds for autoplay categories instead of looping doAutoSpin. Reduce spin_count for long-running cases. Or bump test.setTimeout(900_000) for known slow cases.",
      location,
    };
  }

  // 4. RUNTIME helper timeouts (waitForFeatureComplete, waitForAutoplayRounds, doAutoSpin)
  if (/waitforfeaturecomplete:/i.test(e)) {
    return {
      category: "runtime_timeout",
      title: "Feature chain didn't complete",
      summary: e.includes("didn't start") ?
        "Buy purchase did not produce any spin response — setup likely missed the final BUY/CONFIRM button." :
        "Feature chain stalled mid-way (auto-stop or game disconnect).",
      suggestion: "Open Screenshots — check the last frame of setup. Did the popup actually close? Did reels start? Refine setup_instructions to be more explicit about the final commit click.",
      location,
    };
  }
  if (/waitforautoplayrounds:/i.test(e)) {
    return {
      category: "runtime_timeout",
      title: "Autoplay didn't produce enough rounds",
      summary: e.includes("stall") ?
        "Autoplay stopped emitting new rounds before reaching the target count — likely a stop condition triggered (loss limit, single win cap)." :
        "Autoplay never reached the target round count within the time budget.",
      suggestion: "Check setup pressed Start. Reduce target rounds in test_case.spin_count. Inspect events tab for last spin's stop_reason.",
      location,
    };
  }
  if (/doautospin: hết/i.test(e) || /doautospin: timeout/i.test(e)) {
    return {
      category: "runtime_timeout",
      title: "doAutoSpin couldn't capture a spin response",
      summary: "AI clicked 12+ times but no spin response was captured. Possible: popup blocked the spin button, balance too low, or URL pattern mismatch.",
      suggestion: "Check spin-NN-stuck.png in case Screenshots — that's the UI state when doAutoSpin gave up. Check action trace in error message for what AI was trying.",
      location,
    };
  }

  // 5. AI ERROR (Claude API failed)
  if (/claude.*(error|failed|rate limit|timeout)/i.test(e) || /anthropic/i.test(e)) {
    return {
      category: "ai_error",
      title: "Claude API error",
      summary: "Vision model call failed (network, rate limit, or invalid response).",
      suggestion: "Re-run the case. If recurring, check ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN and the model status.",
      location,
    };
  }

  // 6. CODE BUG (TypeError, ReferenceError)
  if (/typeerror:/i.test(e) || /referenceerror:/i.test(e) || /is not a function/i.test(e)) {
    return {
      category: "code_bug",
      title: "Code bug in test",
      summary: "Generated test code threw a JavaScript runtime error (typically: accessing a property on undefined, or calling a non-function).",
      suggestion: "Open Stack trace below. Common cause: AI-generated assertion accessed spin._raw fields or wrong index into collector.spins. Patch the test() block manually or regenerate the spec.",
      location,
    };
  }
  if (/cannot read prop/i.test(e) || /cannot read properties/i.test(e)) {
    return {
      category: "code_bug",
      title: "Property access on undefined",
      summary: "Test tried to read a property on undefined / null (likely a missing field on a spin response).",
      suggestion: "Provider may not emit that field. Use optional chaining (`spin.x?.y`) or default with `?? 0`.",
      location,
    };
  }

  // 7. ASSERTION FAILURE (Playwright expect() with custom message)
  if (/expect\(.*\)\.\w+\(/i.test(e) || /received:/i.test(e)) {
    // Cố trích assertion ID/message khỏi error
    const idMatch = e.match(/^([a-z][\w-]+)/i);
    const id = idMatch ? idMatch[1] : null;
    return {
      category: "assertion_failure",
      title: id ? `Assertion failed: ${id}` : "Assertion failed",
      summary: "An expected condition was not met. The error message above contains the assertion ID and observed value.",
      suggestion: "Read assertion message — actual values in parentheses tell you what was observed. Check if the assertion logic is correct for this game's response shape (vd PP có flat balance — không dùng start − end formula).",
      location,
    };
  }

  // 8. NETWORK
  if (/spin endpoint|url pattern|network hints/i.test(e)) {
    return {
      category: "network_error",
      title: "Network/endpoint detection issue",
      summary: "Spin URL pattern or field mapping wasn't detected correctly.",
      suggestion: "Check fixtures/specs/{slug}/network-hints.json. Override via QA_SPIN_URL_PATTERN env if needed.",
      location,
    };
  }

  // 9. UNKNOWN
  return {
    category: "unknown",
    title: "Unrecognized error",
    summary: "This error type isn't categorized — check the message above and stack trace for clues.",
    suggestion: "Look at Screenshots and video attachment for visual context. Stack trace points to the failing line.",
    location,
  };
}

function extractLocation(stack: string): string | undefined {
  if (!stack) return undefined;
  // Tìm path đến tests/generated/*.spec.ts:line trước (test code, hữu ích nhất)
  let m = stack.match(/tests\/generated\/[\w-]+\.spec\.ts:\d+(?::\d+)?/);
  if (m) return m[0];
  // Fallback: src/runner/*.ts
  m = stack.match(/src\/runner\/[\w-]+\.ts:\d+(?::\d+)?/);
  if (m) return m[0];
  return undefined;
}
