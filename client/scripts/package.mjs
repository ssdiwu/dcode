#!/usr/bin/env node
// Local, unsigned candidate. Stage the complete Host dependency graph outside the checkout.
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "electron-builder";
const client = fileURLToPath(new URL("..", import.meta.url));
const root = fileURLToPath(new URL("../..", import.meta.url));
const stage = await mkdtemp(join(tmpdir(), "dcode-package-"));
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status})`);
}
try {
  run("npm", ["run", "build"], join(root, "host"));
  await cp(join(root, "host/package.json"), join(stage, "package.json"));
  await cp(
    join(root, "host/package-lock.json"),
    join(stage, "package-lock.json"),
  );
  run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], stage);
  await cp(join(root, "host/dist/src"), join(stage, "dist/src"), {
    recursive: true,
  });
  await cp(join(root,"host/dist/bin"),join(stage,"dist/bin"),{recursive:true});
  await build({
    projectDir: client,
    config: {
      extends: join(client, "electron-builder.yml"),
      ...(process.env.DCODE_PACKAGE_OUTPUT ? { directories: { output: process.env.DCODE_PACKAGE_OUTPUT } } : {}),
      afterPack: async (context) => {
        // electron-builder's resource matcher excludes node_modules; copy the Host's
        // already-pruned dependency tree explicitly into its private resource root.
        await cp(
          join(stage, "node_modules"),
          join(
            context.appOutDir,
            `${context.packager.appInfo.productFilename}.app`,
            "Contents/Resources/host/node_modules",
          ),
          { recursive: true, dereference: true },
        );
      },
      extraResources: [
        { from: stage, to: "host" },
        { from: join(root, "app/Resources/AppIcon.png"), to: "AppIcon.png" },
      ],
    },
  });
} finally {
  await rm(stage, { recursive: true, force: true });
}
