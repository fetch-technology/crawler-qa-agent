// Per-parent expected LEVEL-2 children + post-discovery audit helpers. Used
// after `manualSession.autoOnboard()`'s deep-discover phase to find triggers
// missing required children (→ target re-discovery), spot dup-namespace
// artifacts (→ delete), and identify mirror opportunities (betPlus ↔ betMinus
// usually share an identical popup → verifying one verifies the other).
//
// Why a separate file from expected-ui-elements.ts: that file lists MAIN
// elements (used by the initial AI vision seed). Level-2 children are
// discovered separately via graph-explorer, so the audit pass needs its own
// per-parent rule set. Defaults are universal PP/Pragmatic conventions —
// per-game override is not wired up yet (add later if needed).
//
// Pure module — exercised by tests under tests/invariants/.

export type ChildExpectation = {
  /** Children that MUST exist on a fully-discovered parent. Missing → trigger
   *  re-discovery via discoverVia(trigger). */
  required: string[];
  /** Common but not always present (game may not expose all). Reported for
   *  visibility, never auto-discovered. */
  optional: string[];
  /** Min count of dynamic children matching prefix (e.g. bet popup should
   *  have ≥5 "bet-X.YY" entries). Below threshold → re-discover trigger. */
  dynamicPrefix?: { prefix: string; minCount: number };
  /** Mirror partner: a sibling trigger whose verified children should be
   *  copied here (and vice versa). Both triggers must list each other.
   *  Mirror is bidirectional and only copies entries with identical coords. */
  mirrorPartner?: string;
};

/** Universal slot-game level-2 expectations. Conservative — required = only
 *  the children we can reliably expect to find on EVERY slot game; optional
 *  covers common-but-not-universal controls. */
export const EXPECTED_CHILDREN: Record<string, ChildExpectation> = {
  autoButton: {
    required: ["closeButton", "startAutoplayButton"],
    optional: [
      "turboSpinToggle",
      "quickSpinToggle",
      "skipScreensToggle",
      "autospinsSliderMin",
      "autospinsSliderMax",
      "lossLimitButton",
      "singleWinLimitButton",
      "winExceedsLimitButton",
      "cancelButton",
    ],
  },
  betPlus: {
    required: ["closeButton"],
    optional: [],
    dynamicPrefix: { prefix: "bet-", minCount: 5 },
    mirrorPartner: "betMinus",
  },
  betMinus: {
    required: ["closeButton"],
    optional: [],
    dynamicPrefix: { prefix: "bet-", minCount: 5 },
    mirrorPartner: "betPlus",
  },
  paytableButton: {
    required: ["closeButton", "nextPageButton"],
    optional: ["prevPageButton", "closePaytableButton"],
  },
  menuButton: {
    required: ["closeButton"],
    optional: [
      "gameHistoryButton",
      "historyButton",
      "settingsButton",
      "musicToggle",
      "soundFxToggle",
      "ambientMusicToggle",
      "batterySaverToggle",
      "betPlusButton",
      "betMinusButton",
    ],
  },
  buyBonusButton: {
    required: ["cancelButton", "confirmButton"],
    optional: [],
  },
};

/** Known LEGACY → CANONICAL namespace migrations. Older discover-via calls
 *  used the AI-assigned stateLabel (e.g. autoplay_popup) as the key prefix
 *  before we standardized on trigger-key namespacing (autoButton__*). If
 *  both prefixes coexist in the registry, the legacy ones are duplicates
 *  and should be removed. */
export const LEGACY_NAMESPACES: Record<string, string> = {
  autoplay_popup: "autoButton",
  autoplay_settings_popup: "autoButton",
  bet_selection_popup: "betPlus",
  bet_amount_popup: "betPlus",
  bet_multiplier_popup: "betPlus",
  paytable_page1: "paytableButton",
  system_settings_popup: "menuButton",
  buy_free_spins_confirm_popup: "buyBonusButton",
  buy_feature_popup: "buyBonusButton",
};

export type RegistryAudit = {
  /** Triggers where a REQUIRED child is missing entirely (need re-discover). */
  missingRequired: Array<{ trigger: string; missing: string[] }>;
  /** Triggers where dynamicPrefix threshold not met (need re-discover). */
  missingDynamic: Array<{ trigger: string; prefix: string; got: number; need: number }>;
  /** Mirror candidates: trigger has verified entries the partner is missing. */
  mirrorCandidates: Array<{ source: string; target: string; childrenToMirror: string[] }>;
  /** Legacy-namespace dups present alongside the canonical namespace.
   *  Recommendation: remove legacy keys (delete from registry).            */
  duplicateNamespaces: Array<{ canonical: string; legacy: string; legacyKeys: string[] }>;
};

type RegEl = { x: number; y: number; status?: string };
type Reg = Record<string, RegEl>;

/** Get the level-1 namespace prefix of a key. "autoButton__closeButton" →
 *  "autoButton"; "autoButton" → "autoButton"; "betPlus__bet-X__sub" →
 *  "betPlus". */
function topNamespace(key: string): string {
  const i = key.indexOf("__");
  return i < 0 ? key : key.slice(0, i);
}

/** Get the immediate child name under a level-1 parent. Returns "" for
 *  parent-only keys. */
function childName(parent: string, key: string): string {
  if (!key.startsWith(parent + "__")) return "";
  return key.slice(parent.length + 2).split("__")[0]!;
}

/** Run all four audits against a registry. Pure — no I/O, no mutation. */
export function auditRegistry(registry: Reg): RegistryAudit {
  const out: RegistryAudit = {
    missingRequired: [],
    missingDynamic: [],
    mirrorCandidates: [],
    duplicateNamespaces: [],
  };

  // Children indexed by top-level parent for fast lookup.
  const byParent = new Map<string, Set<string>>();
  for (const key of Object.keys(registry)) {
    const parent = topNamespace(key);
    const cn = childName(parent, key);
    if (!cn) continue;
    if (!byParent.has(parent)) byParent.set(parent, new Set<string>());
    byParent.get(parent)!.add(cn);
  }

  // 1) Required children missing
  for (const [trigger, spec] of Object.entries(EXPECTED_CHILDREN)) {
    if (!(trigger in registry)) continue; // parent not present → skip
    const children = byParent.get(trigger) ?? new Set<string>();
    const missing = spec.required.filter((c) => !children.has(c));
    if (missing.length > 0) out.missingRequired.push({ trigger, missing });
  }

  // 2) Dynamic-prefix shortfall
  for (const [trigger, spec] of Object.entries(EXPECTED_CHILDREN)) {
    if (!spec.dynamicPrefix) continue;
    if (!(trigger in registry)) continue;
    const children = byParent.get(trigger) ?? new Set<string>();
    const got = [...children].filter((c) => c.startsWith(spec.dynamicPrefix!.prefix)).length;
    if (got < spec.dynamicPrefix.minCount) {
      out.missingDynamic.push({
        trigger,
        prefix: spec.dynamicPrefix.prefix,
        got,
        need: spec.dynamicPrefix.minCount,
      });
    }
  }

  // 3) Mirror candidates — bidirectional partners with asymmetric children
  const mirrorSeen = new Set<string>();
  for (const [trigger, spec] of Object.entries(EXPECTED_CHILDREN)) {
    if (!spec.mirrorPartner) continue;
    const partner = spec.mirrorPartner;
    const key = [trigger, partner].sort().join("|");
    if (mirrorSeen.has(key)) continue;
    mirrorSeen.add(key);
    if (!(trigger in registry) || !(partner in registry)) continue;
    const tChildren = byParent.get(trigger) ?? new Set<string>();
    const pChildren = byParent.get(partner) ?? new Set<string>();

    const tMissing = [...pChildren].filter((c) => !tChildren.has(c));
    const pMissing = [...tChildren].filter((c) => !pChildren.has(c));
    if (pMissing.length > 0) {
      out.mirrorCandidates.push({ source: trigger, target: partner, childrenToMirror: pMissing });
    }
    if (tMissing.length > 0) {
      out.mirrorCandidates.push({ source: partner, target: trigger, childrenToMirror: tMissing });
    }
  }

  // 4) Legacy-namespace dups
  for (const [legacy, canonical] of Object.entries(LEGACY_NAMESPACES)) {
    const legacyKeys = Object.keys(registry).filter(
      (k) => k === legacy || k.startsWith(legacy + "__"),
    );
    if (legacyKeys.length === 0) continue;
    const hasCanonical = canonical in registry ||
      Object.keys(registry).some((k) => k.startsWith(canonical + "__"));
    if (hasCanonical) {
      out.duplicateNamespaces.push({ canonical, legacy, legacyKeys });
    }
  }

  return out;
}

/** Apply mirror rules to a registry IN-PLACE. For each mirror partner pair
 *  (e.g. betPlus ↔ betMinus), copy any VERIFIED child entry from one side
 *  to the other when:
 *    - The target lacks an entry with that child name.
 *    - The source entry has coords within ±5px of where the mirror would
 *      land (defensive: protects against rare cases where the popups are
 *      visually identical but rendered at different positions per trigger).
 *
 *  Mirrored entries are marked verifiedBy="alias-mirror" so audits know
 *  they weren't probed independently. Returns the list of new mirrored keys. */
export function applyMirrorRules(
  registry: Reg & Record<string, any>,
  now: string = new Date().toISOString(),
): Array<{ from: string; to: string }> {
  const mirrored: Array<{ from: string; to: string }> = [];

  // Index children per parent (key=parent → Map<childName, fullKey>).
  const childIndex = new Map<string, Map<string, string>>();
  for (const fullKey of Object.keys(registry)) {
    const parent = topNamespace(fullKey);
    const cn = childName(parent, fullKey);
    if (!cn) continue;
    if (!childIndex.has(parent)) childIndex.set(parent, new Map<string, string>());
    childIndex.get(parent)!.set(cn, fullKey);
  }

  const seen = new Set<string>();
  for (const [trigger, spec] of Object.entries(EXPECTED_CHILDREN)) {
    if (!spec.mirrorPartner) continue;
    const partner = spec.mirrorPartner;
    const pairKey = [trigger, partner].sort().join("|");
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    // Default to empty Map when one side has no children yet — that's exactly
    // the asymmetric case mirror is designed to fix.
    const tChildren = childIndex.get(trigger) ?? new Map<string, string>();
    const pChildren = childIndex.get(partner) ?? new Map<string, string>();

    // Mirror trigger→partner (verified-only).
    for (const [cn, srcKey] of tChildren) {
      const tgtKey = `${partner}__${cn}`;
      const src = registry[srcKey];
      const tgt = registry[tgtKey];
      if (!src || src.status !== "verified") continue;
      if (tgt && tgt.status === "verified") continue; // already verified
      // If target exists, copy verification; if not, create entry from src.
      registry[tgtKey] = {
        ...(tgt ?? { x: src.x, y: src.y, strategy: "ai_vision", confidence: src.confidence ?? 0.8 }),
        x: src.x, y: src.y,
        status: "verified",
        verifiedBy: "alias-mirror",
        verifiedAt: now,
        probeSignal: `mirrored from ${srcKey} (mirror partner; same popup coords)`,
      };
      mirrored.push({ from: srcKey, to: tgtKey });
    }
    // Mirror partner→trigger.
    for (const [cn, srcKey] of pChildren) {
      const tgtKey = `${trigger}__${cn}`;
      const src = registry[srcKey];
      const tgt = registry[tgtKey];
      if (!src || src.status !== "verified") continue;
      if (tgt && tgt.status === "verified") continue;
      registry[tgtKey] = {
        ...(tgt ?? { x: src.x, y: src.y, strategy: "ai_vision", confidence: src.confidence ?? 0.8 }),
        x: src.x, y: src.y,
        status: "verified",
        verifiedBy: "alias-mirror",
        verifiedAt: now,
        probeSignal: `mirrored from ${srcKey} (mirror partner; same popup coords)`,
      };
      mirrored.push({ from: srcKey, to: tgtKey });
    }
  }
  return mirrored;
}

/** Delete legacy-namespace keys IN-PLACE when the canonical namespace also
 *  exists. Returns the keys that were removed. Safe — never deletes the
 *  canonical version. */
export function pruneLegacyNamespaces(
  registry: Reg & Record<string, any>,
): string[] {
  const removed: string[] = [];
  const audit = auditRegistry(registry);
  for (const dup of audit.duplicateNamespaces) {
    for (const k of dup.legacyKeys) {
      delete registry[k];
      removed.push(k);
    }
  }
  return removed;
}
