import { generateTestcases, toYaml } from "../step7-testcase-gen/index.js";
import { uiRegistry } from "../registry/ui-registry.js";
import { apiMapping } from "../registry/api-mapping.js";
import { ocrRegions } from "../registry/ocr-regions.js";
import { popupRegions } from "../registry/popup-regions.js";
import { featureRegistry } from "../registry/feature-registry-store.js";
import { testcases } from "../registry/testcases.js";
import { parseArgs, printOk, printErr, requireString } from "./shared.js";

async function main(): Promise<void> {
  const args = parseArgs();
  const slug = requireString(args, "game");

  const features = await featureRegistry.load(slug);
  if (!features) printErr("generate-testcases", `No feature registry for ${slug}. Run discover-features first.`);

  const ui = await uiRegistry.load(slug);
  if (!ui) printErr("generate-testcases", `No ui registry for ${slug}.`);

  const api = await apiMapping.load(slug);
  const ocr = await ocrRegions.load(slug);
  const popups = await popupRegions.load(slug);

  const doc = await generateTestcases({
    features: features!,
    game: slug,
    uiMap: ui!,
    api: api ?? undefined,
    ocrRegions: ocr ?? undefined,
    popupRegions: popups ?? undefined,
  });
  await testcases.save(slug, toYaml(doc));
  printOk(`generated ${doc.testcases.length} testcases`, doc.testcases.map((t) => t.id));
}

main().catch((e) => printErr("generate-testcases", e));
