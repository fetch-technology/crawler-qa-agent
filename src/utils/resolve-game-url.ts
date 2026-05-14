/**
 * Lấy GAME_URL theo thứ tự ưu tiên:
 *   1. CLI arg: `tsx script.ts <url>`  (hoặc `npm run qa -- <url>`)
 *   2. process.env.GAME_URL (từ .env hoặc server runner inject)
 *
 * Nếu thiếu cả hai → print hướng dẫn rõ ràng + exit 1.
 */
export function resolveGameUrl(scriptName: string): string {
  const argUrl = process.argv[2];
  if (argUrl && /^https?:\/\//i.test(argUrl)) {
    try {
      new URL(argUrl);
      return argUrl;
    } catch {
      console.error(`Invalid URL in CLI arg: ${argUrl}`);
      process.exit(1);
    }
  }

  const envUrl = process.env.GAME_URL;
  if (envUrl && envUrl.trim()) {
    try {
      new URL(envUrl);
      return envUrl.trim();
    } catch {
      console.error(`Invalid GAME_URL in env: ${envUrl}`);
      process.exit(1);
    }
  }

  console.error(`
✗ GAME_URL chưa được set. Chọn 1 trong 3 cách:

  1. Dashboard (khuyên dùng — không cần .env):
       npm run serve
       → mở http://localhost:3200/dashboard
       → paste URL vào "New Task"

  2. CLI arg (1 lần):
       npm run ${scriptName} -- 'https://game-url.../?t=...'

  3. .env (persistent):
       echo 'GAME_URL=https://...' >> .env
       npm run ${scriptName}
`);
  process.exit(1);
}
