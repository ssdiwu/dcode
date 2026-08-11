import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  DefaultResourceLoader,
  SettingsManager,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";

export function isExternalDFastSource(source: string): boolean {
  const normalized = source.trim().replaceAll("\\", "/").toLowerCase();
  if (/^(?:npm:)?pi-dfast(?:@[^/]+)?$/.test(normalized)) return true;
  return normalized
    .split(/[/?#]/)
    .some((segment) => /^pi-dfast(?:@[^/]+|\.git|\.[cm]?[jt]s)?$/.test(segment));
}

function withoutExternalDFast<T extends ReturnType<SettingsManager["getGlobalSettings"]>>(settings: T): T {
  const packages = settings.packages?.filter((entry) => (
    !isExternalDFastSource(typeof entry === "string" ? entry : entry.source)
  ));
  const extensions = settings.extensions?.filter((entry) => !isExternalDFastSource(entry));
  return {
    ...settings,
    ...(packages === undefined ? {} : { packages }),
    ...(extensions === undefined ? {} : { extensions }),
  };
}

function filteredSettingsDocument(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const current = readFileSync(path, "utf8");
  try {
    return JSON.stringify(withoutExternalDFast(JSON.parse(current)));
  } catch {
    return current;
  }
}

export function createDCodeResourceSettingsManager(options: {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
}): SettingsManager {
  const paths = {
    global: join(options.agentDir, "settings.json"),
    project: join(options.cwd, CONFIG_DIR_NAME, "settings.json"),
  };
  const storage = {
    withLock(
      scope: "global" | "project",
      update: (current: string | undefined) => string | undefined,
    ): void {
      const next = update(filteredSettingsDocument(paths[scope]));
      if (next !== undefined) {
        throw new Error("D Code resource settings are read-only");
      }
    },
  };
  return SettingsManager.fromStorage(storage, { projectTrusted: options.projectTrusted });
}

function isExternalDFastResource(resource: ResolvedResource): boolean {
  return [resource.path, resource.metadata.source, resource.metadata.baseDir]
    .some((candidate) => typeof candidate === "string" && isExternalDFastSource(candidate));
}

export async function resolveDCodeExtensionPaths(options: {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
}): Promise<string[]> {
  const packageManager = new DefaultPackageManager(options);
  const resolved = await packageManager.resolve();
  return [...new Set(
    resolved.extensions
      .filter((extension) => extension.enabled && !isExternalDFastResource(extension))
      .map((extension) => extension.path),
  )];
}

type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
type LoaderReloadOptions = Parameters<DefaultResourceLoader["reload"]>[0];
type ExtensionResourcePaths = Parameters<DefaultResourceLoader["extendResources"]>[0];

export class DCodeResourceLoader {
  private readonly resourceSettingsManager: SettingsManager;
  private readonly loader: DefaultResourceLoader;

  constructor(private readonly options: {
    cwd: string;
    agentDir: string;
    sourceSettingsManager: SettingsManager;
    extensionFactories: NonNullable<LoaderOptions["extensionFactories"]>;
  }) {
    this.resourceSettingsManager = createDCodeResourceSettingsManager({
      cwd: options.cwd,
      agentDir: options.agentDir,
      projectTrusted: options.sourceSettingsManager.isProjectTrusted(),
    });
    this.loader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: options.agentDir,
      settingsManager: this.resourceSettingsManager,
      noExtensions: true,
      additionalExtensionPaths: [],
      extensionFactories: options.extensionFactories,
    });
  }

  getExtensions(): ReturnType<DefaultResourceLoader["getExtensions"]> {
    return this.loader.getExtensions();
  }

  getSkills(): ReturnType<DefaultResourceLoader["getSkills"]> {
    return this.loader.getSkills();
  }

  getPrompts(): ReturnType<DefaultResourceLoader["getPrompts"]> {
    return this.loader.getPrompts();
  }

  getThemes(): ReturnType<DefaultResourceLoader["getThemes"]> {
    return this.loader.getThemes();
  }

  getAgentsFiles(): ReturnType<DefaultResourceLoader["getAgentsFiles"]> {
    return this.loader.getAgentsFiles();
  }

  getSystemPrompt(): ReturnType<DefaultResourceLoader["getSystemPrompt"]> {
    return this.loader.getSystemPrompt();
  }

  getSystemPromptSource(): ReturnType<DefaultResourceLoader["getSystemPromptSource"]> {
    return this.loader.getSystemPromptSource();
  }

  getAppendSystemPrompt(): ReturnType<DefaultResourceLoader["getAppendSystemPrompt"]> {
    return this.loader.getAppendSystemPrompt();
  }

  getAppendSystemPromptSources(): ReturnType<DefaultResourceLoader["getAppendSystemPromptSources"]> {
    return this.loader.getAppendSystemPromptSources();
  }

  extendResources(paths: ExtensionResourcePaths): void {
    this.loader.extendResources(paths);
  }

  async reload(options?: LoaderReloadOptions): Promise<void> {
    this.resourceSettingsManager.setProjectTrusted(this.options.sourceSettingsManager.isProjectTrusted());
    const extensionPaths = await resolveDCodeExtensionPaths({
      cwd: this.options.cwd,
      agentDir: this.options.agentDir,
      settingsManager: this.resourceSettingsManager,
    });
    // Pi 0.84.1 has no PackageManager injection point. Updating this pinned loader field
    // keeps its cache-clearing reload lifecycle while replacing the pre-load extension set.
    (this.loader as unknown as { additionalExtensionPaths: string[] }).additionalExtensionPaths = extensionPaths;
    await this.loader.reload(options);
    this.options.sourceSettingsManager.setProjectTrusted(this.resourceSettingsManager.isProjectTrusted());
  }
}
