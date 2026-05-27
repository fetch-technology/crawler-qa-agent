export type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  timestamp: number;
};

export type CapturedResponse = {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string | null;
  timing: { startedAt: number; finishedAt: number };
};

export type CapturedWsFrame = {
  direction: "sent" | "received";
  payload: string;
  timestamp: number;
};

export type NetworkRound = {
  index: number;
  requests: CapturedRequest[];
  responses: CapturedResponse[];
  wsFrames: CapturedWsFrame[];
  screenshots: string[];
};

export type CaptureHandle = {
  rounds: NetworkRound[];
  flush(): NetworkRound[];
  stop(): NetworkRound[];
};
