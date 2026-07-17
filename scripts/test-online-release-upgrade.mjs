import { spawnSync } from "node:child_process";
import { log } from "node:console";
import { resolve } from "node:path";
import process from "node:process";

const cliPath = resolve(
  "node_modules/zotero-plugin-scaffold/bin/zotero-plugin.mjs",
);

for (const stage of ["upgrade", "idempotency"]) {
  log(`\n[online-release-upgrade] ${stage}`);
  const result = spawnSync(process.execPath, [cliPath, "test", "--no-watch"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PAPERCHAT_ONLINE_RELEASE_UPGRADE_STAGE: stage,
    },
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
