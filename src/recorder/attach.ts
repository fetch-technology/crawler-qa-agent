import type { Page, BrowserContext, Request, Response, WebSocket } from "playwright";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactUrl } from "../utils/url.js";

type HttpEntry = {
  t: number;
  phase: "request" | "response" | "failed";
  method?: string;
  url: string;
  resourceType?: string;
  status?: number;
  headers?: Record<string, string>;
  postData?: string | null;
  body?: string | null;
  bodyTruncated?: boolean;
  failure?: string;
};

type WsEntry = {
  t: number;
  wsId: number;
  direction: "open" | "close" | "sent" | "received" | "error";
  url?: string;
  payload?: string;
  payloadType?: "text" | "binary";
  error?: string;
};

const MAX_BODY_BYTES = 512 * 1024;
const RESOURCE_TYPES_TO_CAPTURE = new Set(["xhr", "fetch", "websocket", "document", "other"]);
const BODY_SKIP_TYPES = new Set(["image", "media", "font", "stylesheet", "script"]);

export type RecorderHandle = {
  runDir: string;
  t0: number;
  counts: { http: number; ws: number; console: number };
  hostCounts: Record<string, number>;
  wsOpenUrls: Set<string>;
  finalize: (meta: {
    gameUrl: string;
    gameSlug: string;
    operator: string | null;
    stopReason: string;
    extra?: Record<string, unknown>;
  }) => Promise<void>;
};

export async function attachRecorder(
  context: BrowserContext,
  page: Page,
  runDir: string,
): Promise<RecorderHandle> {
  await mkdir(runDir, { recursive: true });
  await mkdir(join(runDir, "screenshots"), { recursive: true });

  const t0 = Date.now();
  const now = () => Date.now() - t0;
  const counts = { http: 0, ws: 0, console: 0 };
  const hostCounts: Record<string, number> = {};
  const wsOpenUrls = new Set<string>();

  const httpStream = createWriteStream(join(runDir, "http.jsonl"), { flags: "a" });
  const wsStream = createWriteStream(join(runDir, "ws.jsonl"), { flags: "a" });
  const consoleStream = createWriteStream(join(runDir, "console.jsonl"), { flags: "a" });

  const writeLine = (s: WriteStream, obj: unknown) => {
    s.write(JSON.stringify(obj) + "\n");
  };

  page.on("console", (msg) => {
    counts.console++;
    writeLine(consoleStream, { t: now(), type: msg.type(), text: msg.text() });
  });
  page.on("pageerror", (err) => {
    counts.console++;
    writeLine(consoleStream, { t: now(), type: "pageerror", text: err.message });
  });

  page.on("request", (req: Request) => {
    if (!RESOURCE_TYPES_TO_CAPTURE.has(req.resourceType())) return;
    counts.http++;
    writeLine(httpStream, {
      t: now(),
      phase: "request",
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      headers: req.headers(),
      postData: req.postData() ?? null,
    } satisfies HttpEntry);
  });

  page.on("response", async (res: Response) => {
    const req = res.request();
    if (!RESOURCE_TYPES_TO_CAPTURE.has(req.resourceType())) return;
    const entry: HttpEntry = {
      t: now(),
      phase: "response",
      method: req.method(),
      url: res.url(),
      resourceType: req.resourceType(),
      status: res.status(),
      headers: res.headers(),
    };
    if (!BODY_SKIP_TYPES.has(req.resourceType())) {
      try {
        const buf = await res.body();
        if (buf.byteLength > MAX_BODY_BYTES) {
          entry.body = buf.subarray(0, MAX_BODY_BYTES).toString("utf8");
          entry.bodyTruncated = true;
        } else {
          entry.body = buf.toString("utf8");
        }
      } catch {
        // body có thể không lấy được (redirect, cache...)
      }
    }
    counts.http++;
    try {
      const host = new URL(entry.url).host;
      hostCounts[host] = (hostCounts[host] ?? 0) + 1;
    } catch {}
    writeLine(httpStream, entry);
  });

  page.on("requestfailed", (req: Request) => {
    counts.http++;
    writeLine(httpStream, {
      t: now(),
      phase: "failed",
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      failure: req.failure()?.errorText ?? "unknown",
    } satisfies HttpEntry);
  });

  let wsCounter = 0;
  page.on("websocket", (socket: WebSocket) => {
    const wsId = ++wsCounter;
    wsOpenUrls.add(socket.url());
    counts.ws++;
    writeLine(wsStream, { t: now(), wsId, direction: "open", url: socket.url() } satisfies WsEntry);

    socket.on("framesent", (frame) => {
      const payload = typeof frame.payload === "string" ? frame.payload : frame.payload.toString("base64");
      counts.ws++;
      writeLine(wsStream, {
        t: now(),
        wsId,
        direction: "sent",
        payload,
        payloadType: typeof frame.payload === "string" ? "text" : "binary",
      } satisfies WsEntry);
    });
    socket.on("framereceived", (frame) => {
      const payload = typeof frame.payload === "string" ? frame.payload : frame.payload.toString("base64");
      counts.ws++;
      writeLine(wsStream, {
        t: now(),
        wsId,
        direction: "received",
        payload,
        payloadType: typeof frame.payload === "string" ? "text" : "binary",
      } satisfies WsEntry);
    });
    socket.on("close", () => {
      counts.ws++;
      writeLine(wsStream, { t: now(), wsId, direction: "close" } satisfies WsEntry);
    });
    socket.on("socketerror", (err) => {
      counts.ws++;
      writeLine(wsStream, { t: now(), wsId, direction: "error", error: String(err) } satisfies WsEntry);
    });
  });

  let stopped = false;
  const finalize: RecorderHandle["finalize"] = async (meta) => {
    if (stopped) return;
    stopped = true;

    const summary = {
      gameUrl: redactUrl(meta.gameUrl),
      gameSlug: meta.gameSlug,
      operator: meta.operator,
      startedAt: new Date(t0).toISOString(),
      durationMs: Date.now() - t0,
      stopReason: meta.stopReason,
      counts: { ...counts },
      httpHosts: { ...hostCounts },
      wsHosts: [...wsOpenUrls],
      ...(meta.extra ?? {}),
    };
    await writeFile(join(runDir, "summary.json"), JSON.stringify(summary, null, 2));

    await Promise.all([
      new Promise<void>((r) => httpStream.end(r)),
      new Promise<void>((r) => wsStream.end(r)),
      new Promise<void>((r) => consoleStream.end(r)),
    ]);
  };

  return { runDir, t0, counts, hostCounts, wsOpenUrls, finalize };
}
