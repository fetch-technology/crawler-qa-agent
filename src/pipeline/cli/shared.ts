import "dotenv/config";

export type CliArgs = Record<string, string | boolean>;

export function parseArgs(argv = process.argv.slice(2)): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token) continue;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

export function requireString(args: CliArgs, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    console.error(`Missing required flag: --${key}`);
    process.exit(2);
  }
  return v;
}

export function optionalString(args: CliArgs, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

export function optionalNumber(args: CliArgs, key: string): number | undefined {
  const v = args[key];
  if (typeof v !== "string") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function printOk(label: string, data?: unknown): void {
  console.log(`[ok] ${label}`);
  if (data !== undefined) console.log(JSON.stringify(data, null, 2));
}

export function printErr(label: string, err: unknown): never {
  console.error(`[err] ${label}: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
}
