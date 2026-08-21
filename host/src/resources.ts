import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { DCodeResourceLoader } from "./resource-policy.js";

/** Pi settings `packages` 条目的来源键：字符串原样，对象取 source 字段。 */
export function packageSourceKey(entry: unknown): string | undefined {
  if (typeof entry === "string" && entry.length > 0) return entry;
  if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
    const source = (entry as { source?: unknown }).source;
    if (typeof source === "string" && source.length > 0) return source;
  }
  return undefined;
}

export interface PackageEntry {
  source: string;
  kind: "npm" | "path";
  enabled: boolean;
}

export interface ExtensionEntry {
  name: string;
  path: string;
  source: string;
  toolCount: number;
  commandCount: number;
}

export interface SkillEntry {
  name: string;
  description: string;
  source: string;
  filePath: string;
  disableModelInvocation: boolean;
}

export interface PromptEntry {
  name: string;
  description: string;
  argumentHint: string | null;
  source: string;
  filePath: string;
}

export interface CommandEntry {
  name: string;
  description: string | null;
  source: string;
}

export interface ResourceDiagnosticEntry {
  message: string;
}

export interface ResourcesSnapshot {
  packages: PackageEntry[];
  extensions: ExtensionEntry[];
  skills: SkillEntry[];
  prompts: PromptEntry[];
  commands: CommandEntry[];
  diagnostics: ResourceDiagnosticEntry[];
}

/**
 * 停用扩展包的影子清单：停用即从 Pi 全局 `packages` 移除原始条目，
 * 原始值（字符串或对象）完整保存在此，启用时原样恢复。
 * 文件位于 `agentDir/pi-dcode/disabled-packages.json`，原子写。
 */
export class DisabledPackageStore {
  constructor(readonly path: string) {}

  async load(): Promise<unknown[]> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async save(entries: unknown[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
    try {
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

function sourceLabel(sourceInfo: unknown): string {
  const source = (sourceInfo as { source?: unknown } | undefined)?.source;
  return typeof source === "string" && source.length > 0 ? source : "unknown";
}

/** 从真实加载结果收集资源快照：隐藏的 D Code 内联扩展不出现在用户面。 */
export function collectResourcesSnapshot(options: {
  loader: DCodeResourceLoader;
  settingsManager: SettingsManager;
  disabled: unknown[];
}): ResourcesSnapshot {
  const disabledKeys = new Set(
    options.disabled.map(packageSourceKey).filter((key): key is string => key !== undefined),
  );

  const packages: PackageEntry[] = [];
  const seenKeys = new Set<string>();
  for (const entry of options.settingsManager.getGlobalSettings().packages ?? []) {
    const key = packageSourceKey(entry);
    if (key === undefined || seenKeys.has(key)) continue;
    seenKeys.add(key);
    packages.push({
      source: key,
      kind: key.startsWith("npm:") ? "npm" : "path",
      enabled: !disabledKeys.has(key),
    });
  }
  for (const entry of options.disabled) {
    const key = packageSourceKey(entry);
    if (key === undefined || seenKeys.has(key)) continue;
    seenKeys.add(key);
    packages.push({ source: key, kind: key.startsWith("npm:") ? "npm" : "path", enabled: false });
  }

  const loaded = options.loader.getExtensions();
  const extensions: ExtensionEntry[] = loaded.extensions
    .filter((extension) => !extension.hidden)
    .map((extension) => ({
      name: basename(extension.path),
      path: extension.resolvedPath || extension.path,
      source: sourceLabel(extension.sourceInfo),
      toolCount: extension.tools?.size ?? 0,
      commandCount: extension.commands?.size ?? 0,
    }));

  const loadedSkills = options.loader.getSkills();
  const skills: SkillEntry[] = loadedSkills.skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    source: sourceLabel(skill.sourceInfo),
    filePath: skill.filePath,
    disableModelInvocation: skill.disableModelInvocation === true,
  }));

  const loadedPrompts = options.loader.getPrompts();
  const prompts: PromptEntry[] = loadedPrompts.prompts.map((prompt) => ({
    name: prompt.name,
    description: prompt.description,
    argumentHint: prompt.argumentHint ?? null,
    source: sourceLabel(prompt.sourceInfo),
    filePath: prompt.filePath,
  }));

  const commands: CommandEntry[] = [
    ...loaded.extensions.flatMap((extension) =>
      [...(extension.commands?.values() ?? [])].map((command) => ({
        name: command.name,
        description: command.description ?? null,
        source: sourceLabel(extension.sourceInfo),
      })),
    ),
    ...prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      source: "prompt",
    })),
    ...skills.map((skill) => ({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill",
    })),
  ];

  const diagnostics: ResourceDiagnosticEntry[] = [
    ...loaded.errors.map((error) => ({ message: `${error.path}: ${error.error}` })),
    ...loadedSkills.diagnostics.map((diagnostic) => ({ message: String(diagnostic) })),
    ...loadedPrompts.diagnostics.map((diagnostic) => ({ message: String(diagnostic) })),
  ];

  return { packages, extensions, skills, prompts, commands, diagnostics };
}

export function disabledPackageStorePath(agentDir: string): string {
  return join(agentDir, "pi-dcode", "disabled-packages.json");
}
