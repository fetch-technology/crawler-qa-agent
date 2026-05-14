export type GameUrlInfo = {
  raw: string;
  origin: string;
  pathname: string;
  host: string;
  gameSlug: string;
  provider: string; // short code: PP, RG, PG, etc.
  providerName: string; // display name
  token: string | null;
  operator: string | null;
  lang: string | null;
  returnUrl: string | null;
};

const PROVIDER_RULES: Array<{ hostPattern: RegExp; code: string; name: string }> = [
  { hostPattern: /pragmaticplay\.com/i, code: "PP", name: "Pragmatic Play" },
  { hostPattern: /revenge-games\.com/i, code: "RG", name: "Revenge Games" },
  { hostPattern: /pgsoft\.com/i, code: "PG", name: "PG Soft" },
  { hostPattern: /evoplay\.games/i, code: "EVO", name: "Evoplay" },
  { hostPattern: /netent\.com/i, code: "NE", name: "NetEnt" },
  { hostPattern: /playngo\.com/i, code: "PNG", name: "Play'n GO" },
  { hostPattern: /spribe\.io/i, code: "SPR", name: "Spribe" },
];

const SLUG_SKIP = new Set([
  "en",
  "vi",
  "th",
  "id",
  "zh",
  "ja",
  "ko",
  "games",
  "game",
  "play",
  "slots",
  "slot",
  "launcher",
  "launch",
  "demo",
  "lobby",
  "client",
]);

export function parseGameUrl(raw: string): GameUrlInfo {
  const u = new URL(raw);
  const segments = u.pathname.split("/").filter(Boolean);

  // Heuristic: duyệt ngược từ cuối, bỏ qua segment chung chung
  let gameSlug = "unknown";
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!.toLowerCase();
    if (SLUG_SKIP.has(seg)) continue;
    gameSlug = segments[i]!;
    break;
  }
  if (gameSlug === "unknown" && segments[0]) gameSlug = segments[0];

  let provider = "??";
  let providerName = "Unknown";
  for (const rule of PROVIDER_RULES) {
    if (rule.hostPattern.test(u.host)) {
      provider = rule.code;
      providerName = rule.name;
      break;
    }
  }

  return {
    raw,
    origin: u.origin,
    pathname: u.pathname,
    host: u.host,
    gameSlug,
    provider,
    providerName,
    token: u.searchParams.get("t") ?? u.searchParams.get("token"),
    operator: u.searchParams.get("oc") ?? u.searchParams.get("operator"),
    lang: u.searchParams.get("l") ?? u.searchParams.get("lang"),
    returnUrl: u.searchParams.get("r") ?? u.searchParams.get("return"),
  };
}

/**
 * Nếu QA_FORCE_LANG env set (e.g. "en"), rewrite tham số ?l= / ?lang= trong URL.
 * Không set thì return nguyên URL.
 */
export function forceLangIfRequested(raw: string): string {
  const forceLang = process.env.QA_FORCE_LANG;
  if (!forceLang) return raw;
  try {
    const u = new URL(raw);
    let changed = false;
    for (const key of ["l", "lang", "language"]) {
      if (u.searchParams.has(key) && u.searchParams.get(key) !== forceLang) {
        u.searchParams.set(key, forceLang);
        changed = true;
      }
    }
    // Nếu URL không có lang param → thêm l=
    if (!u.searchParams.has("l") && !u.searchParams.has("lang") && !u.searchParams.has("language")) {
      u.searchParams.set("l", forceLang);
      changed = true;
    }
    return changed ? u.toString() : raw;
  } catch {
    return raw;
  }
}

export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const key of ["t", "token", "auth"]) {
      if (u.searchParams.has(key)) u.searchParams.set(key, "***REDACTED***");
    }
    return u.toString();
  } catch {
    return raw;
  }
}
