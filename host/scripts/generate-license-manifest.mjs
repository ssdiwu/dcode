import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const nodeModulesRoot = process.argv[2] ? resolve(process.argv[2]) : undefined;
const outputPath = process.argv[3] ? resolve(process.argv[3]) : undefined;

if (!nodeModulesRoot || !outputPath) {
  throw new Error(
    "usage: node generate-license-manifest.mjs <node_modules> <output>",
  );
}

const reviewedLicenses = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-3-Clause",
  "ISC",
  "MIT",
]);
const reviewedPackagesWithoutLicenseFiles = new Set([
  "@aws-sdk/credential-provider-http@3.972.39",
  "@aws-sdk/credential-provider-http@3.972.69",
  "@aws-sdk/credential-provider-login@3.972.41",
  "@aws-sdk/credential-provider-login@3.972.74",
  "@aws-sdk/nested-clients@3.997.9",
  "@aws-sdk/nested-clients@3.997.41",
  "@earendil-works/pi-agent-core@0.84.1",
  "@earendil-works/pi-ai@0.84.1",
  "@earendil-works/pi-client@0.84.1",
  "@earendil-works/pi-coding-agent@0.84.1",
  "@earendil-works/pi-protocol@0.84.1",
  "@earendil-works/pi-telemetry@0.84.1",
  "@earendil-works/pi-tui@0.84.1",
  "@mariozechner/clipboard@0.3.9",
  "@mariozechner/clipboard-darwin-arm64@0.3.9",
  "@mariozechner/clipboard-darwin-universal@0.3.9",
  "@nodable/entities@2.1.0",
  "data-uri-to-buffer@4.0.1",
  "xml-naming@0.1.0",
]);

const records = new Map();
const unreviewedMissingLicenseFiles = new Set();

async function directoryEntries(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function inspectPackage(packageDirectory) {
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(join(packageDirectory, "package.json"), "utf8"),
    );
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return;
    throw error;
  }

  const name = manifest.name;
  const version = manifest.version;
  const license = manifest.license;
  if (typeof name !== "string" || typeof version !== "string") {
    throw new Error(`invalid package metadata: ${packageDirectory}`);
  }
  if (typeof license !== "string" || !reviewedLicenses.has(license)) {
    throw new Error(
      `unreviewed license for ${name}@${version}: ${String(license)}`,
    );
  }

  const packageEntries = await directoryEntries(packageDirectory);
  const licenseFiles = packageEntries
    .filter(
      (entry) =>
        entry.isFile() &&
        /^(license|licence|copying|notice)([-._]|$)/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const key = `${name}@${version}`;
  if (
    licenseFiles.length === 0 &&
    !reviewedPackagesWithoutLicenseFiles.has(key)
  ) {
    unreviewedMissingLicenseFiles.add(key);
  }
  const previous = records.get(key);
  const mergedFiles = new Set([...(previous?.licenseFiles ?? []), ...licenseFiles]);
  records.set(key, { name, version, license, licenseFiles: [...mergedFiles].sort() });

  await inspectNodeModules(join(packageDirectory, "node_modules"));
}

async function inspectNodeModules(directory) {
  for (const entry of await directoryEntries(directory)) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const candidate = join(directory, entry.name);
    if (entry.name.startsWith("@")) {
      for (const scopedEntry of await directoryEntries(candidate)) {
        if (!scopedEntry.isDirectory() && !scopedEntry.isSymbolicLink()) continue;
        await inspectPackage(join(candidate, scopedEntry.name));
      }
      continue;
    }
    await inspectPackage(candidate);
  }
}

await inspectNodeModules(nodeModulesRoot);

if (unreviewedMissingLicenseFiles.size > 0) {
  throw new Error(
    `missing unreviewed license text for:\n${[
      ...unreviewedMissingLicenseFiles,
    ]
      .sort()
      .map((key) => `- ${key}`)
      .join("\n")}`,
  );
}

const sortedRecords = [...records.values()].sort((left, right) =>
  `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
);
const lines = [
  "D Code embedded npm production packages",
  "",
  "Package\tLicense\tRetained license files",
  ...sortedRecords.map(({ name, version, license, licenseFiles }) =>
    [
      `${name}@${version}`,
      license,
      licenseFiles.length > 0 ? licenseFiles.join(", ") : "see Missing-NPM-License-Notices.txt",
    ].join("\t"),
  ),
  "",
];

await writeFile(outputPath, lines.join("\n"), "utf8");
process.stdout.write(`Wrote ${sortedRecords.length} unique package notices to ${outputPath}\n`);
