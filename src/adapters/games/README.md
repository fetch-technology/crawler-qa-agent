# Per-game adapter overrides

Most games are handled automatically by `provider × mechanic` composition.
Add a file here ONLY when a game has quirks beyond what its provider/mechanic combo handles.

## When to add

- Game has a unique paytable shape (vd cluster tiers with non-standard size buckets)
- Cascade chain semantics differ from default (vd "tumble multiplier" persists across cascades)
- Custom symbol type that doesn't fit WILD/SCATTER/PICTURE_SYMBOL
- Wild substitution rule deviates (vd "wild only on reels 2-4")
- Custom max-win cap or feature buy logic

## When NOT to add

- Game uses standard PP gs2c wire format → already handled by `pragmaticProvider`
- Game uses standard ways/paylines/cluster math → already handled by mechanic adapter
- Game has features but they map to common GameSpec.features → catalog mapper handles

## Template

```ts
// src/adapters/games/sweet-bonanza-xmas.ts
import { composeGameAdapter } from "../compose.js";
import { pragmaticProvider } from "../providers/pragmatic.js";
import { clusterMechanic } from "../mechanics/cluster.js";
import { registerAdapter } from "../registry.js";

registerAdapter("sweet-bonanza-xmas", (args) => {
  const base = composeGameAdapter({
    gameCode: "sweet-bonanza-xmas",
    provider: pragmaticProvider,
    mechanic: clusterMechanic,
    spec: args.spec ?? null,
  });
  // Override specific methods
  return {
    ...base,
    validateSpin: (input) => {
      const errors = base.validateSpin(input);
      // Add custom rule: max single-spin win ≤ 21,100× bet (advertised cap)
      if (input.response.win > input.request.bet * 21100) {
        errors.push({
          code: "PAYOUT_MISMATCH",
          severity: "error",
          detail: `Win ${input.response.win} exceeds advertised max ${input.request.bet * 21100}`,
        });
      }
      return errors;
    },
  };
});
```

Then import this file in `src/adapters/index.ts` `bootstrapAdapters()` to register on startup.

## Auto-discovery

For minimal-overhead games, just edit `fixtures/specs/{slug}/{slug}.spec.json`:
- Set `mechanic_type` accurately
- Set `cascade` flag
- Set `cluster_min_size` if cluster
- Provide `paylines` if paylines

That alone is enough — no per-game adapter file needed. Add a file only when behavior cannot be expressed via spec fields.
