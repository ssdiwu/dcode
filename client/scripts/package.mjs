#!/usr/bin/env node
// Local, unsigned candidate. Stage the complete Host dependency graph outside the checkout.
import { mkdtemp, cp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "electron-builder";
const client = fileURLToPath(new URL("..", import.meta.url));
const root = fileURLToPath(new URL("../..", import.meta.url));
const stagingRoot = await mkdtemp(join(tmpdir(), "dcode-package-"));
const stage = join(stagingRoot, "host");
const legal = join(stagingRoot, "Legal");
const clientDependencies = join(stagingRoot, "client");
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status})`);
}
try {
  await Promise.all([stage, legal, clientDependencies].map(path => mkdir(path)));
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
  // Preserve notices for both the standalone Host and bundled renderer dependencies.
  // This separate tree excludes development tools; it is never embedded as executable code.
  await cp(join(client, "package.json"), join(clientDependencies, "package.json"));
  await cp(join(client, "package-lock.json"), join(clientDependencies, "package-lock.json"));
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], clientDependencies);
  await cp(join(root, "LICENSE"), join(legal, "D-Code-LICENSE.txt"));
  await cp(join(root, "THIRD_PARTY_NOTICES.md"), join(legal, "THIRD-PARTY-NOTICES.md"));
  await cp(join(root, "legal"), legal, { recursive: true });
  await cp(join(stage, "node_modules/@aws-sdk/client-bedrock-runtime/LICENSE"), join(legal, "Apache-2.0-LICENSE.txt"));
  // Electron carries its Node/Chromium third-party notices; there is no separate Node binary.
  await cp(join(client, "node_modules/electron/dist/LICENSE"), join(legal, "Electron-LICENSE.txt"));
  await cp(join(client, "node_modules/electron/dist/LICENSES.chromium.html"), join(legal, "Electron-THIRD-PARTY-LICENSES.html"));
  const manifest = join(root, "host/scripts/generate-license-manifest.mjs");
  for (const [scope, directory] of [["host", stage], ["client", clientDependencies]]) {
    run(process.execPath, [manifest, join(directory, "node_modules"), join(legal, `${scope}-npm-packages.txt`), join(legal, `${scope}-licenses`)], root);
  }
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
        { from: legal, to: "Legal" },
        { from: join(root, "app/Resources/AppIcon.png"), to: "AppIcon.png" },
      ],
    },
  });
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}
