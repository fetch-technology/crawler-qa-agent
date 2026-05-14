import { cleanAll, cleanGame } from "./utils/cleanup.js";

function main() {
  const arg = process.argv[2]?.trim();

  if (!arg || arg === "--all") {
    console.log("================================================================");
    console.log(" CLEAN ALL — wipe toàn bộ fixtures + generated tests + reports");
    console.log("================================================================");
    console.log("Kept: src/, public/, node_modules/, .env, .git, package.json\n");
    const res = cleanAll();
    if (res.removed.length === 0) {
      console.log("Không có gì để xóa (tất cả folder đã không tồn tại).");
    } else {
      console.log(`Đã xóa ${res.removed.length} folder:`);
      for (const p of res.removed) console.log(`  - ${p}`);
    }
    return;
  }

  if (arg === "--help" || arg === "-h") {
    console.log(`Usage:
  npm run clean                   — xóa TẤT CẢ game data
  npm run clean -- <slug>          — xóa data của 1 game theo slug
  npm run clean -- sweet-bonanza-2500
  npm run clean -- fortune-pig

Scope khi xóa 1 slug:
  - fixtures/recordings/{slug}__*
  - fixtures/rules/{slug}__*
  - fixtures/options/{slug}__*
  - fixtures/specs/{slug}/
  - tests/generated/{slug}.spec.ts

KHÔNG động: fixtures/tasks/ (task history). Để xóa task data, dùng dashboard Retry.
`);
    return;
  }

  console.log("================================================================");
  console.log(` CLEAN GAME: ${arg}`);
  console.log("================================================================");
  const res = cleanGame(arg);
  if (res.removed.length === 0) {
    console.log(`Không tìm thấy data cho slug "${arg}".`);
  } else {
    console.log(`Đã xóa ${res.removed.length} item:`);
    for (const p of res.removed) console.log(`  - ${p}`);
  }
}

main();
