import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../app.json" with { type: "json" };
import packageInfo from "../package.json" with { type: "json" };

const sdkVersion = packageInfo.dependencies["@evenrealities/even_hub_sdk"];
const directory = mkdtempSync(join(tmpdir(), "g2-planetarium-"));
try {
  const path = join(directory, "app.json");
  writeFileSync(path, JSON.stringify({ ...manifest, min_sdk_version: sdkVersion }, null, 2) + "\n");
  const result = spawnSync(process.execPath, [
    fileURLToPath(import.meta.resolve("@evenrealities/evenhub-cli/main.js")),
    "pack", path, "dist", "--sdk-ver", sdkVersion, "-o", "g2-planetarium.ehpk",
  ], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
