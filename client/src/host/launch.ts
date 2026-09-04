export interface HostLaunchInput {
  /** 用于执行 host 入口的可执行文件：纯 Node 二进制，或 Electron 二进制（需 executableIsElectron）。 */
  executablePath: string;
  executableIsElectron?: boolean;
  hostEntryPath: string;
  agentDirPath: string;
  dataRootPath?: string;
  extraArgs?: readonly string[];
  baseEnv?: NodeJS.ProcessEnv;
}

export interface HostLaunchPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

const NODE_WARNING_FLAG = "--disable-warning=ExperimentalWarning";

/**
 * Host 子进程启动计划（议题一收口：ZCode 同款机制）。
 * 环境合同平移自 Swift HostLocator：PI_CODING_AGENT_DIR、NO_COLOR、
 * NODE_OPTIONS 告警抑制；Electron 二进制以 ELECTRON_RUN_AS_NODE 的
 * Node 模式执行 host 入口，不单独打包 Node 运行时。
 */
export function planHostLaunch(input: HostLaunchInput): HostLaunchPlan {
  const args = [
    NODE_WARNING_FLAG,
    input.hostEntryPath,
    "--agent-dir",
    input.agentDirPath,
  ];
  if (input.dataRootPath) args.push("--data-root", input.dataRootPath);
  args.push(...(input.extraArgs ?? []));

  const env: NodeJS.ProcessEnv = { ...(input.baseEnv ?? process.env) };
  env.NO_COLOR = "1";
  env.PI_CODING_AGENT_DIR = input.agentDirPath;
  const inherited = (env.NODE_OPTIONS ?? "").trim();
  env.NODE_OPTIONS = inherited.includes(NODE_WARNING_FLAG)
    ? inherited
    : [inherited, NODE_WARNING_FLAG].filter(part => part.length > 0).join(" ");
  if (input.executableIsElectron) env.ELECTRON_RUN_AS_NODE = "1";

  return { command: input.executablePath, args, env };
}
