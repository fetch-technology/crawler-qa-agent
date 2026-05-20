import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Lane = "pr" | "nightly";

type Step = {
  name: string;
  cmd: string;
  args: string[];
};

function parseLane(): { lane: Lane; dryRun: boolean } {
  const laneArg = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  if (laneArg !== "pr" && laneArg !== "nightly") {
    console.error("Usage: tsx src/lanes/run-lane.ts <pr|nightly> [--dry-run]");
    process.exit(2);
  }
  return { lane: laneArg, dryRun };
}

function discoverGeneratedSpecs(kind: "hybrid" | "runtime"): string[] {
  const dir = join(process.cwd(), "tests", "generated");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir);
  if (kind === "hybrid") {
    return files
      .filter((f) => f.endsWith(".hybrid.spec.ts"))
      .map((f) => join("tests", "generated", f))
      .sort();
  }
  return files
    .filter((f) => f.endsWith(".spec.ts"))
    .filter((f) => !f.endsWith(".hybrid.spec.ts") && !f.endsWith(".unified.spec.ts"))
    .map((f) => join("tests", "generated", f))
    .sort();
}

function discoverSlugsFromScenarios(): string[] {
  const dir = join(process.cwd(), "fixtures", "scenarios");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => existsSync(join(dir, n)))
    .sort();
}

function buildPrSteps(): Step[] {
  const hybridSpecs = discoverGeneratedSpecs("hybrid");
  const steps: Step[] = [
    {
      name: "Deterministic core tests",
      cmd: "npx",
      args: [
        "playwright",
        "test",
        "tests/deterministic-example.spec.ts",
        "tests/deterministic-hybrid.spec.ts",
        "tests/deterministic-integration.spec.ts",
        "tests/mechanics.spec.ts",
        "--reporter=line",
      ],
    },
    {
      name: "Critical visual snapshot regression",
      cmd: "npx",
      args: ["playwright", "test", "tests/visual-regression.spec.ts", "--reporter=line"],
    },
    {
      name: "Scenario minimum audit",
      cmd: "npm",
      args: ["run", "measure:scenario-min"],
    },
    {
      name: "Skip projection audit",
      cmd: "npm",
      args: ["run", "measure:skip-projection"],
    },
  ];

  if (hybridSpecs.length > 0) {
    steps.splice(1, 0, {
      name: "Generated hybrid deterministic suite",
      cmd: "npx",
      args: ["playwright", "test", ...hybridSpecs, "--reporter=line"],
    });
  }

  return steps;
}

function buildNightlySteps(): Step[] {
  const runtimeSpecs = discoverGeneratedSpecs("runtime");
  const slugs = discoverSlugsFromScenarios();
  const statsSpins = Number(process.env.NIGHTLY_STATS_SPINS ?? 200);
  const statsConcurrency = Number(process.env.NIGHTLY_STATS_CONCURRENCY ?? 2);
  const statsThrottle = Number(process.env.NIGHTLY_STATS_THROTTLE_MS ?? 10);

  const steps: Step[] = [];

  if (runtimeSpecs.length > 0) {
    steps.push({
      name: "Generated real-network runtime suite",
      cmd: "npx",
      args: ["playwright", "test", ...runtimeSpecs, "--reporter=line"],
    });
  }

  steps.push(
    {
      name: "Scenario minimum audit",
      cmd: "npm",
      args: ["run", "measure:scenario-min"],
    },
    {
      name: "Skip projection audit",
      cmd: "npm",
      args: ["run", "measure:skip-projection"],
    },
    {
      name: "Pre-game replay/fallback stats",
      cmd: "npm",
      args: ["run", "pregame-stats"],
    },
  );

  for (const slug of slugs) {
    steps.push({
      name: `Statistical simulation (${slug})`,
      cmd: "npm",
      args: [
        "run",
        "stats",
        "--",
        slug,
        "--spins",
        String(statsSpins),
        "--concurrency",
        String(statsConcurrency),
        "--throttle",
        String(statsThrottle),
      ],
    });
  }

  return steps;
}

function runStep(step: Step, dryRun: boolean): void {
  const pretty = `${step.cmd} ${step.args.join(" ")}`;
  console.log(`\n=== ${step.name} ===`);
  console.log(pretty);
  if (dryRun) return;

  const r = spawnSync(step.cmd, step.args, {
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

function main(): void {
  const { lane, dryRun } = parseLane();
  console.log(`[lane] ${lane}${dryRun ? " (dry-run)" : ""}`);

  const steps = lane === "pr" ? buildPrSteps() : buildNightlySteps();
  if (steps.length === 0) {
    console.log("No steps resolved. Nothing to run.");
    return;
  }

  for (const step of steps) {
    runStep(step, dryRun);
  }

  console.log(`\n[lane] ${lane} completed`);
}

main();
