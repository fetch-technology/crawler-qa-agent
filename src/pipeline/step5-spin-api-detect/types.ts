import type { ApiMapping, FieldMapping } from "../registry/types.js";

export type CandidateScore = {
  url: string;
  method: "GET" | "POST";
  score: number;
  reasons: string[];
};

export type SpinApiDetection = {
  api: ApiMapping;
  fields: FieldMapping;
  candidates: CandidateScore[];
  confidence: number;
};
