/**
 * Heuristic structured extraction từ raw GET /{game}/config response.
 *
 * Provider config (PP, PG, Cocos…) thường chứa info "cứng" như bet_sizes,
 * paytable, feature config — đáng tin hơn rules text được transcribe từ UI.
 * Module này walk JSON tree, phát hiện các shape phổ biến và format thành
 * markdown sections để feed vào AI catalog generator.
 */

type Json = unknown;

export type StructuredConfig = {
  bet_table: { sizes?: number[]; levels?: number[]; formula?: string } | null;
  paytable: Array<{ symbol: string; multipliers?: Record<string, string | number>; raw?: string }>;
  features: Array<{ name: string; config: Json }>;
  caps: { max_win?: string | number; max_win_multiplier?: string | number; rtp?: string | number };
  raw_keys_top: string[];
  notes: string[];
};

const NUMERIC_ARRAY_NAME_HINTS = [
  /bet/i,
  /stake/i,
  /chip/i,
  /denom/i,
  /coin/i,
  /level/i,
];

const PAYTABLE_NAME_HINTS = [/pay(table|out)?s?$/i, /symbol/i, /multipliers?$/i];
const FEATURE_NAME_HINTS = [
  /feature/i,
  /freeSpin/i,
  /buy/i,
  /ante/i,
  /doubleChance/i,
  /bonus/i,
  /multiplier/i,
];
const CAP_HINTS = {
  max_win: [/maxWin$/i, /winCap/i, /maxPayout/i],
  rtp: [/^rtp$/i, /returnToPlayer/i],
};

function isNumericArray(v: Json): v is number[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number");
}
function isStringArray(v: Json): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string");
}
function matches(name: string, hints: RegExp[]): boolean {
  return hints.some((re) => re.test(name));
}

/** Walk tree (limited depth + node count) → find candidates by key name. */
function walk(
  node: Json,
  cb: (path: string[], key: string, value: Json) => void,
  path: string[] = [],
  budget = { nodes: 5000 },
) {
  if (budget.nodes-- <= 0) return;
  if (node && typeof node === "object" && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) {
      cb([...path, k], k, v);
      if (v && typeof v === "object") walk(v, cb, [...path, k], budget);
    }
  } else if (Array.isArray(node)) {
    // Walk into array items so nested config (PP "modes": [{...}]) is visited
    for (let i = 0; i < Math.min(node.length, 20); i++) {
      const item = node[i];
      if (item && typeof item === "object") walk(item, cb, [...path, `[${i}]`], budget);
    }
  }
}

export function extractStructuredFromConfig(config: Json): StructuredConfig {
  const out: StructuredConfig = {
    bet_table: null,
    paytable: [],
    features: [],
    caps: {},
    raw_keys_top: [],
    notes: [],
  };
  if (!config || typeof config !== "object") {
    out.notes.push("config không phải object — bỏ qua");
    return out;
  }
  out.raw_keys_top = Object.keys(config as Record<string, Json>).slice(0, 60);

  // Bet sizes / levels: numeric arrays under bet-related key names
  const betSizeCands: { path: string; arr: number[] }[] = [];
  const betLevelCands: { path: string; arr: number[] }[] = [];

  walk(config, (path, key, value) => {
    const pathStr = path.join(".");

    // bet sizes
    if (isNumericArray(value) && matches(key, NUMERIC_ARRAY_NAME_HINTS)) {
      if (/level/i.test(key)) betLevelCands.push({ path: pathStr, arr: value });
      else betSizeCands.push({ path: pathStr, arr: value });
    }

    // paytable: object/array under paytable-ish key
    if (matches(key, PAYTABLE_NAME_HINTS)) {
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 30)) {
          if (item && typeof item === "object") {
            const obj = item as Record<string, Json>;
            const symbol =
              (typeof obj.symbol === "string" ? obj.symbol : null) ??
              (typeof obj.name === "string" ? obj.name : null) ??
              (typeof obj.code === "string" ? obj.code : null) ??
              (typeof obj.id === "string" || typeof obj.id === "number" ? String(obj.id) : null);
            if (symbol) {
              const mults: Record<string, string | number> = {};
              for (const [mk, mv] of Object.entries(obj)) {
                if (/^\d+$/.test(mk) && (typeof mv === "number" || typeof mv === "string")) {
                  mults[mk] = mv;
                }
                if (/^x?\d+$/.test(mk) && (typeof mv === "number" || typeof mv === "string")) {
                  mults[mk] = mv;
                }
              }
              out.paytable.push({
                symbol,
                multipliers: Object.keys(mults).length ? mults : undefined,
                raw: Object.keys(mults).length ? undefined : JSON.stringify(obj).slice(0, 200),
              });
            }
          } else if (typeof item === "string" || typeof item === "number") {
            out.paytable.push({ symbol: String(item) });
          }
        }
      } else if (value && typeof value === "object") {
        for (const [sym, mults] of Object.entries(value as Record<string, Json>).slice(0, 30)) {
          if (mults && typeof mults === "object") {
            const m: Record<string, string | number> = {};
            for (const [mk, mv] of Object.entries(mults)) {
              if (typeof mv === "number" || typeof mv === "string") m[mk] = mv;
            }
            out.paytable.push({ symbol: sym, multipliers: m });
          } else if (typeof mults === "number" || typeof mults === "string") {
            out.paytable.push({ symbol: sym, raw: String(mults) });
          }
        }
      }
    }

    // features: object containing feature-named keys
    if (matches(key, FEATURE_NAME_HINTS) && value && typeof value === "object") {
      // Skip top-level placeholder (we want the actual config block)
      out.features.push({
        name: pathStr,
        config: pruneDeep(value, 4, 20),
      });
    }

    // caps
    for (const [capName, hints] of Object.entries(CAP_HINTS)) {
      if (matches(key, hints) && (typeof value === "string" || typeof value === "number")) {
        (out.caps as Record<string, string | number>)[capName] = value;
      }
    }
    if (/multiplier/i.test(key) && /max|cap/i.test(pathStr) && (typeof value === "string" || typeof value === "number")) {
      out.caps.max_win_multiplier = value;
    }
  });

  // Pick the LARGEST bet-size candidate (most likely the full chip range)
  betSizeCands.sort((a, b) => b.arr.length - a.arr.length);
  betLevelCands.sort((a, b) => b.arr.length - a.arr.length);
  if (betSizeCands.length) {
    out.bet_table = { sizes: betSizeCands[0]!.arr };
    if (betLevelCands.length) out.bet_table.levels = betLevelCands[0]!.arr;
    if (betSizeCands.length > 1) {
      out.notes.push(
        `Multiple bet-size candidates found (${betSizeCands.map((c) => c.path).slice(0, 3).join(", ")}); used ${betSizeCands[0]!.path}`,
      );
    }
  }

  // Dedupe features by name
  const seen = new Set<string>();
  out.features = out.features.filter((f) => {
    if (seen.has(f.name)) return false;
    seen.add(f.name);
    return true;
  });

  return out;
}

/** Truncate deep object — keep shape recognizable but bound size. */
function pruneDeep(node: Json, maxDepth: number, maxKeys: number, depth = 0): Json {
  if (depth >= maxDepth) return "[truncated:depth]";
  if (Array.isArray(node)) {
    return node.slice(0, maxKeys).map((v) => pruneDeep(v, maxDepth, maxKeys, depth + 1));
  }
  if (node && typeof node === "object") {
    const out: Record<string, Json> = {};
    let i = 0;
    for (const [k, v] of Object.entries(node)) {
      if (i++ >= maxKeys) {
        out["…"] = `[truncated:${Object.keys(node).length - maxKeys} more keys]`;
        break;
      }
      out[k] = pruneDeep(v, maxDepth, maxKeys, depth + 1);
    }
    return out;
  }
  return node;
}

/** Format StructuredConfig as readable markdown for AI prompt. */
export function structuredConfigToMarkdown(s: StructuredConfig): string {
  const lines: string[] = ["# Structured Config (parsed from API response)", ""];

  if (s.bet_table) {
    lines.push("## Bet table");
    if (s.bet_table.sizes) lines.push(`- bet sizes (${s.bet_table.sizes.length}): ${s.bet_table.sizes.slice(0, 30).join(", ")}${s.bet_table.sizes.length > 30 ? ", …" : ""}`);
    if (s.bet_table.levels) lines.push(`- bet levels (${s.bet_table.levels.length}): ${s.bet_table.levels.join(", ")}`);
    if (s.bet_table.formula) lines.push(`- formula: ${s.bet_table.formula}`);
    lines.push("");
  }

  if (s.paytable.length) {
    lines.push(`## Paytable (${s.paytable.length} symbols)`);
    for (const p of s.paytable.slice(0, 30)) {
      const mults = p.multipliers
        ? Object.entries(p.multipliers)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")
        : p.raw ?? "(no multipliers extracted)";
      lines.push(`- **${p.symbol}**: ${mults}`);
    }
    if (s.paytable.length > 30) lines.push(`- … (${s.paytable.length - 30} more)`);
    lines.push("");
  }

  if (s.features.length) {
    lines.push(`## Features (${s.features.length})`);
    for (const f of s.features) {
      lines.push(`### ${f.name}`);
      lines.push("```json");
      lines.push(JSON.stringify(f.config, null, 2).slice(0, 1500));
      lines.push("```");
    }
    lines.push("");
  }

  if (Object.keys(s.caps).length) {
    lines.push("## Caps & RTP");
    for (const [k, v] of Object.entries(s.caps)) lines.push(`- ${k}: ${v}`);
    lines.push("");
  }

  if (s.raw_keys_top.length) {
    lines.push("## Top-level config keys");
    lines.push(s.raw_keys_top.join(", "));
    lines.push("");
  }

  if (s.notes.length) {
    lines.push("## Notes");
    for (const n of s.notes) lines.push(`- ${n}`);
  }

  return lines.join("\n");
}
