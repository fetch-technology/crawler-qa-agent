// Pair request body to its matching response body. For PP / RG-style providers
// where the same URL handles multiple actions (doInit, doSpin, doCollect), we
// can't match by URL alone — we use temporal proximity (response within 5s
// of request, request closest in time to response) as the heuristic.

import type {
  CapturedRequest,
  CapturedResponse,
  NetworkRound,
} from "./types.js";

export type RequestResponsePair = {
  request: CapturedRequest | null;
  response: CapturedResponse;
};

const MAX_PAIRING_GAP_MS = 8000;

export function pairRequestsToResponses(rounds: NetworkRound[]): RequestResponsePair[] {
  const allRequests: CapturedRequest[] = [];
  const allResponses: CapturedResponse[] = [];
  for (const r of rounds) {
    allRequests.push(...r.requests);
    allResponses.push(...r.responses);
  }
  return allResponses.map((response) => ({
    response,
    request: findMatchingRequest(response, allRequests),
  }));
}

function findMatchingRequest(
  response: CapturedResponse,
  requests: CapturedRequest[],
): CapturedRequest | null {
  let best: CapturedRequest | null = null;
  let bestDelta = Infinity;
  for (const req of requests) {
    if (req.url !== response.url) continue;
    const delta = response.timing.startedAt - req.timestamp;
    if (delta < 0 || delta > MAX_PAIRING_GAP_MS) continue;
    if (delta < bestDelta) {
      best = req;
      bestDelta = delta;
    }
  }
  return best;
}
