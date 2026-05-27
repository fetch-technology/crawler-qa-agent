import type { Page, Request, Response } from "playwright";
import type {
  CaptureHandle,
  CapturedRequest,
  CapturedResponse,
  CapturedWsFrame,
  NetworkRound,
} from "./types.js";

export function startCapture(page: Page): CaptureHandle {
  const requests: CapturedRequest[] = [];
  const responses: CapturedResponse[] = [];
  const wsFrames: CapturedWsFrame[] = [];

  const onRequest = (req: Request) => {
    requests.push({
      url: req.url(),
      method: req.method(),
      headers: req.headers(),
      body: req.postData() ?? null,
      timestamp: Date.now(),
    });
  };

  const onResponse = async (res: Response) => {
    const startedAt = Date.now();
    let body: string | null = null;
    try {
      body = await res.text();
    } catch {
      body = null;
    }
    responses.push({
      url: res.url(),
      status: res.status(),
      headers: res.headers(),
      body,
      timing: { startedAt, finishedAt: Date.now() },
    });
  };

  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("websocket", (ws) => {
    ws.on("framesent", (e) => {
      wsFrames.push({
        direction: "sent",
        payload: typeof e.payload === "string" ? e.payload : e.payload.toString("utf8"),
        timestamp: Date.now(),
      });
    });
    ws.on("framereceived", (e) => {
      wsFrames.push({
        direction: "received",
        payload: typeof e.payload === "string" ? e.payload : e.payload.toString("utf8"),
        timestamp: Date.now(),
      });
    });
  });

  const rounds: NetworkRound[] = [];

  const flush = (): NetworkRound[] => {
    const round: NetworkRound = {
      index: rounds.length,
      requests: requests.splice(0),
      responses: responses.splice(0),
      wsFrames: wsFrames.splice(0),
      screenshots: [],
    };
    rounds.push(round);
    return rounds;
  };

  const stop = (): NetworkRound[] => {
    page.off("request", onRequest);
    page.off("response", onResponse);
    return flush();
  };

  return { rounds, flush, stop };
}
