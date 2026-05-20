/**
 * Compose a `GameAdapter` from a `ProviderAdapter` × `MechanicAdapter` + spec.
 *
 * Per-game overrides can replace any GameAdapter method by passing
 * `overrides`. Useful for games with one-off quirks that don't fit a clean
 * provider/mechanic boundary (vd cascade encoding particular to one title).
 */

import { assertPayoutMatchesPaytable } from "../runner/rule-engine.js";
import type { GameSpec } from "../ai/authoring.js";
import type {
  GameAdapter,
  MechanicAdapter,
  ProviderAdapter,
  SpinValidationInput,
  TestCase,
  ValidationError,
} from "./types.js";

export type ComposeArgs = {
  gameCode: string;
  provider: ProviderAdapter;
  mechanic: MechanicAdapter;
  /** GameSpec for paytable / invariants. Optional — some callers only need parsing. */
  spec?: GameSpec | null;
  /** Per-game override functions. */
  overrides?: Partial<GameAdapter>;
};

export function composeGameAdapter(args: ComposeArgs): GameAdapter {
  const { gameCode, provider, mechanic, spec, overrides } = args;

  const detectSpinRequest = (raw: string, url?: string): boolean => {
    if (url && !provider.urlPattern.test(url)) return false;
    if (url && provider.skipUrl(url)) return false;
    const parsed = provider.parseBody(raw);
    if (!parsed) return false;
    // Request shape: has bet/coin/level fields. Use scoreSpinShape ≥ 4.
    const s = provider.scoreSpinShape(parsed);
    return s.score >= 4;
  };

  const detectSpinResponse = (raw: string, url?: string): boolean => {
    if (url && !provider.urlPattern.test(url)) return false;
    if (url && provider.skipUrl(url)) return false;
    const parsed = provider.parseBody(raw);
    if (!parsed) return false;
    const s = provider.scoreSpinShape(parsed);
    return s.score >= 5;
  };

  const parseRequest = (raw: string) => {
    const parsed = provider.parseBody(raw);
    if (!parsed) throw new Error(`parseRequest: cannot parse body for ${gameCode}`);
    return provider.parseRequest(parsed);
  };

  const parseResponse = (raw: string) => {
    const parsed = provider.parseBody(raw);
    if (!parsed) throw new Error(`parseResponse: cannot parse body for ${gameCode}`);
    return provider.parseResponse(parsed);
  };

  const decodeReels = (symbols: string, width: number, height: number) =>
    mechanic.decodeReels(symbols, width, height);

  const validateSpin = (input: SpinValidationInput): ValidationError[] => {
    const errors: ValidationError[] = [];
    const { request, response, spec: specIn, tolerance = 0.01 } = input;

    // Reels decode check
    if (response.reels.length === 0) {
      errors.push({
        code: "REELS_DECODE",
        severity: "warn",
        detail: `Response has no decoded reels (width=${response.width}, height=${response.height})`,
      });
    }

    // Bet conservation: response.bet should match request.bet
    if (
      request.bet > 0 &&
      Math.abs(response.bet - request.bet) > tolerance &&
      !response.isFreeSpin
    ) {
      errors.push({
        code: "BET_INVALID",
        severity: "error",
        detail: `Request bet=${request.bet} vs response bet=${response.bet} mismatch`,
      });
    }

    // Balance conservation
    if (
      response.balanceBefore != null &&
      Math.abs(
        response.balanceAfter -
          (response.balanceBefore - (response.isFreeSpin ? 0 : response.bet) + response.win),
      ) > tolerance
    ) {
      errors.push({
        code: "BALANCE_MISMATCH",
        severity: "error",
        detail: `balanceAfter=${response.balanceAfter} ≠ before(${response.balanceBefore}) - bet(${response.isFreeSpin ? 0 : response.bet}) + win(${response.win})`,
      });
    }

    // Payout check — delegate to existing rule-engine if spec available
    if (specIn) {
      try {
        const payout = assertPayoutMatchesPaytable(response.raw, specIn, tolerance);
        if (payout.ok === false) {
          errors.push({
            code: "PAYOUT_MISMATCH",
            severity: "error",
            detail: payout.detail,
            data: { expected: payout.expected, actual: payout.actual, delta: payout.delta },
          });
        } else if (payout.ok === "inconclusive") {
          errors.push({
            code: "INCONCLUSIVE",
            severity: "info",
            detail: payout.reason,
            data: { serverWin: payout.serverWin, calculatedBaseline: payout.calculatedBaseline },
          });
        }
      } catch (err) {
        errors.push({
          code: "INCONCLUSIVE",
          severity: "warn",
          detail: `Payout check threw: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    return errors;
  };

  const generateTestCases = (): TestCase[] => {
    if (!spec || !spec.invariants?.length) return [];
    return spec.invariants.map((inv) => ({
      id: `${gameCode}::${inv.id}`,
      title: inv.description,
      scenarioLabel:
        inv.applies_to === "free_spin"
          ? "free_spin"
          : inv.applies_to === "session"
            ? "no_win"
            : "normal_win",
      invariants: [inv.id],
    }));
  };

  const defaultAdapter: GameAdapter = {
    gameCode,
    providerCode: provider.providerCode,
    mechanicCode: mechanic.mechanicCode,
    detectSpinRequest,
    detectSpinResponse,
    parseRequest,
    parseResponse,
    decodeReels,
    validateSpin,
    generateTestCases,
    shouldMockRoute: provider.shouldMockRoute,
  };

  return { ...defaultAdapter, ...overrides };
}
