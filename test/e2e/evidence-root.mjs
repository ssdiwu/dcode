// E2E 证据的统一隔离输出根。
//
// 根因：多个界面用例把证据硬编码写进 doc/验证记录/<带日期的历史归档>/evidence，
// 复跑会静默覆盖旧截图与 JSON——历史记录是当时的实际证据，不能被下一次运行顶掉。
//
// 规则：
// 1. 默认写入 test/e2e/evidence/runs/<运行标识>/（已被 .gitignore 忽略，不进版本控制）。
// 2. DCODE_EVIDENCE_ROOT 可把整批证据重定向到别处（例如归档当次验证记录）。
// 3. doc/验证记录 是只读历史：默认拒绝写入；确需就地重生成某一份记录时，
//    显式给 DCODE_EVIDENCE_ALLOW_HISTORY=1，并在记录里说明这是重生成而非新增证据。
//
// 归档流程：先跑进隔离根，确认结果后再由交付者把需要的产物复制进某份带日期的验证记录，
// 并在 README 里写明来源；测试本身不直接写归档目录。

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const historyRoot = join(repoRoot, "doc/验证记录");

/** 运行标识：默认取本地时刻（文件名安全），可用 DCODE_EVIDENCE_RUN 固定以便复现同一目录。 */
export const RUN_ID =
  process.env.DCODE_EVIDENCE_RUN ??
  new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");

export const EVIDENCE_ROOT = process.env.DCODE_EVIDENCE_ROOT
  ? resolve(repoRoot, process.env.DCODE_EVIDENCE_ROOT)
  : join(import.meta.dirname, "evidence", "runs", RUN_ID);

const allowHistory = process.env.DCODE_EVIDENCE_ALLOW_HISTORY === "1";

/**
 * 任何写入路径都必须过这道校验，包括按用例保留的旧环境变量（DCODE_VISUAL_* 等）。
 * 早先这些覆盖路径直接 mkdir，绕过了本文件的保护，等于留了一条直写历史归档的后门。
 */
export function assertWritableEvidencePath(candidate) {
  const target = resolve(repoRoot, candidate);
  if (!allowHistory && (target === historyRoot || target.startsWith(`${historyRoot}/`))) {
    throw new Error(
      `拒绝把 E2E 证据写进历史归档目录 ${target}：复跑会覆盖既有证据。` +
        "先跑进隔离根，确认后再归档；确需就地重生成请显式设 DCODE_EVIDENCE_ALLOW_HISTORY=1。",
    );
  }
  return target;
}

assertWritableEvidencePath(EVIDENCE_ROOT);

/** 按用例保留的旧环境变量覆盖：先过同一道校验，缺省时返回 null。 */
export const overrideEvidencePath = (value) => (value ? assertWritableEvidencePath(value) : null);

/** 用例自己的子目录（同名用例写同一个子目录，互不混淆）；顺带建目录。 */
export function evidenceDir(...segments) {
  const dir = join(EVIDENCE_ROOT, ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}