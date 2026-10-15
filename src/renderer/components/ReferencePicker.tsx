// C05 引用入口：输入区的「＋」次级入口（向上展开）+ 草稿里的可移除引用项。
//
// 边界（spec 页面与交互组件.md#c05-引用入口载荷归属与竞态）：
// - 发现、选取都经隔离桥到主进程；界面不直连文件系统、Node、Electron 或 Pi。
// - 打开、查看、移除都只改草稿：不发送、不开始执行、不安装、不新增成员授权。
// - 失败按真实原因码呈现，不加半成品引用，也不展示演示成功。
// - 迟到结果按 scope（会话/工作空间）比对：不匹配当前选择就丢弃，不覆盖新会话的列表。

import { useCallback, useEffect, useRef, useState } from "react";
import { Paperclip, Plus, X } from "lucide-react";
import { REFERENCE_ISSUE_CODES } from "@/contracts";
import type { ReferenceCandidate, ReferenceIssueCode, ReferenceListing, WorkReference } from "@/contracts";
import { Button } from "./Button";
import { createReferenceGate, runGated, scopeKeyOf } from "./reference-gate";
import { useT } from "../i18n";

/** 从桥抛出的原因里认出已定义的原因码；认不出就按 unreadable 呈现，但原文一定带出来。 */
function inferIssueCode(message: string): ReferenceIssueCode {
  const hit = REFERENCE_ISSUE_CODES.find((code) => message.includes(code));
  return hit ?? "unreadable";
}

type ListingState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; listing: ReferenceListing }
  | { phase: "failed"; code: ReferenceIssueCode; message: string };

export function ReferencePicker({
  scope,
  onAdd,
}: {
  /** 归属：已有会话给 sessionId；新任务草稿给 taskId。null = 无归属，不能发现引用 */
  scope: { sessionId?: string; taskId?: string } | null;
  onAdd: (reference: WorkReference) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ListingState>({ phase: "idle" });
  const [adding, setAdding] = useState<string | null>(null);
  /** 本次列表请求的新旧序号：同一归属内关面板再打开时区分新旧加载 */
  const requestIdRef = useRef(0);
  const [note, setNote] = useState<string | null>(null);

  const scopeKey = scopeKeyOf(scope);
  /**
   * 归属门禁（C05 竞态，判定见 reference-gate.ts）：
   * 归属一换或组件卸载，在途结果立即作废——A→B→A 回到同一归属也是新一代。
   * advance 放在 render 期是有意的：效果提交之前回来的结果同样必须立刻作废。
   */
  const gateRef = useRef<ReturnType<typeof createReferenceGate> | null>(null);
  gateRef.current ??= createReferenceGate(scopeKey);
  gateRef.current.advance(scopeKey);
  const gate = gateRef.current;
  useEffect(() => {
    gate.mount();
    return () => gate.dispose();
  }, [gate]);

  const load = useCallback(async () => {
    if (!scope) return;
    const requestId = ++requestIdRef.current;
    setState({ phase: "loading" });
    setNote(null);
    const input = scope.sessionId ? { sessionId: scope.sessionId } : { taskId: scope.taskId as string };
    const outcome = await runGated(gate, () => window.dcode.listReferences({ ...input, operationId: `ui-${requestId}` }));
    // 目标已换／已卸载：整段丢弃，不碰列表、不弹原因。
    if (outcome.status !== "applied") {
      if (outcome.status === "failed") setState({ phase: "failed", code: inferIssueCode(outcome.message), message: outcome.message });
      return;
    }
    // 同一归属内的旧加载、以及回包里与当前归属不符的范围，都不得呈现。
    if (requestId !== requestIdRef.current) return;
    if (scopeKeyOf(outcome.value.scope) !== gate.current()) return;
    setState({ phase: "ready", listing: outcome.value });
    // 依赖用归属身份 scopeKey 而不是 scope 对象本身：后者每次渲染都是新对象，
    // 挂在它上面会让 load 每次渲染重建，恰好破坏我们要的迟到保护语义。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, gate]);

  useEffect(() => {
    // 换会话/换草稿任务：重新读取当前归属的列表；关闭浮层不改变草稿。
    if (open && scope) void load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, open]);

  const choose = async (candidate: ReferenceCandidate) => {
    if (!scope) return;
    setAdding(candidate.locator);
    setNote(null);
    const input = scope.sessionId ? { sessionId: scope.sessionId } : { taskId: scope.taskId as string };
    const outcome = await runGated(gate, () =>
      window.dcode.captureReference({ ...input, kind: candidate.kind, locator: candidate.locator }));
    // 组件已卸载就到此为止：不再写任何状态。
    if (!gate.isMounted()) return;
    setAdding(null);
    // 迟到且目标已换：这份快照属于旧选择，不能加进草稿，也不能恢复用户已经移除的项，
    // 更不能落到用户此刻正在编辑的另一份草稿上。
    if (outcome.status !== "applied") {
      // 失败要显示真实原因，不是一句通用文案：把桥抛出的原文带上（它本身不含路径栈或凭据）。
      if (outcome.status === "failed") setNote(outcome.message);
      return;
    }
    onAdd(outcome.value);
  };

  const issue = state.phase === "failed" ? t(`references.issue.${state.code}` as never) : null;
  const listing = state.phase === "ready" ? state.listing : null;
  const empty = listing !== null && listing.files.length === 0 && listing.skills.length === 0;

  return (
    <div className="relative">
      <Button
        type="button"
        data-slot="composer-references-trigger"
        variant="ghost"
        size="sm"
        aria-label={t("references.entry")}
        title={t("references.entry")}
        disabled={!scope}
        onClick={() => setOpen((value) => !value)}
      >
        <Plus className="size-4" strokeWidth={1.75} />
      </Button>
      {open && (
        // 向上展开：贴底卡片不被滚动容器裁切（与 C03 菜单同一方向口径）
        <div
          data-slot="composer-references-panel"
          className="glass absolute bottom-full left-0 z-50 mb-2 max-h-72 w-80 overflow-y-auto rounded-lg p-2 shadow-[var(--shadow-float)]"
          role="dialog"
          aria-label={t("references.entry")}
        >
          {state.phase === "loading" && <p className="px-2 py-1.5 text-ui-xs text-subtlest">{t("references.loading")}</p>}
          {issue && (
            <p data-slot="references-error" className="px-2 py-1.5 text-ui-xs text-danger">
              {issue}
              {state.phase === "failed" && state.message ? `：${state.message}` : ""}
            </p>
          )}
          {note && <p data-slot="references-note" className="px-2 py-1.5 text-ui-xs text-danger">{note}</p>}
          {empty && <p className="px-2 py-1.5 text-ui-xs text-subtlest">{t("references.empty")}</p>}
          {listing?.files.length ? (
            <Section title={t("references.files")}>
              {listing.files.map((file) => (
                <Row key={`file:${file.locator}`} candidate={file} busy={adding === file.locator} onPick={choose} />
              ))}
            </Section>
          ) : null}
          {listing?.skills.length ? (
            <Section title={t("references.skills")}>
              {listing.skills.map((skill) => (
                <Row key={`skill:${skill.locator}`} candidate={skill} busy={adding === skill.locator} onPick={choose} />
              ))}
            </Section>
          ) : null}
          {listing?.issues.length ? (
            <ul className="px-2 pt-1 text-ui-xs text-subtlest">
              {listing.issues.map((item) => (
                <li key={`${item.code}-${item.message}`}>{item.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="py-1">
      <h3 className="px-2 pb-1 text-ui-xs font-medium text-subtle">{title}</h3>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function Row({
  candidate,
  busy,
  onPick,
}: {
  candidate: ReferenceCandidate;
  busy: boolean;
  onPick: (candidate: ReferenceCandidate) => Promise<void>;
}) {
  const t = useT();
  return (
    <button
      type="button"
      data-slot="reference-option"
      data-kind={candidate.kind}
      data-locator={candidate.locator}
      disabled={busy}
      onClick={() => { void onPick(candidate); }}
      className="flex items-baseline gap-2 rounded px-2 py-1.5 text-left text-ui-xs hover:bg-surface-raised disabled:opacity-60"
    >
      <Paperclip className="size-3 shrink-0 translate-y-0.5 text-subtlest" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate">{candidate.label}</span>
      <span className="shrink-0 text-subtlest">{candidate.detail ?? candidate.locator}</span>
      <span className="sr-only">{t(candidate.kind === "skill" ? "references.kind.skill" : "references.kind.file")}</span>
    </button>
  );
}

/** 草稿里的引用项：可移除，不改文字、不发送、不动运行状态。 */
export function ReferenceChips({
  references,
  onRemove,
}: {
  references: readonly WorkReference[];
  onRemove: (refId: string) => void;
}) {
  const t = useT();
  if (references.length === 0) return null;
  return (
    <div data-slot="composer-references" className="flex flex-wrap gap-1.5 px-3 pt-2">
      {references.map((ref) => (
        <span
          key={ref.refId}
          data-slot="reference-chip"
          data-kind={ref.kind}
          data-refid={ref.refId}
          className="inline-flex max-w-72 items-center gap-1 rounded-md bg-surface-raised px-2 py-1 text-ui-xs"
        >
          <Paperclip className="size-3 shrink-0 text-subtlest" strokeWidth={1.75} />
          <span className="min-w-0 truncate">{ref.label}</span>
          {ref.snapshot.truncated && (
            <span className="shrink-0 text-subtlest">
              {t("references.truncated").replace("{used}", String(ref.snapshot.content.length)).replace("{total}", String(ref.snapshot.byteSize))}
            </span>
          )}
          <button
            type="button"
            data-slot="reference-remove"
            aria-label={t("references.remove").replace("{name}", ref.label)}
            title={t("references.remove").replace("{name}", ref.label)}
            className="shrink-0 rounded p-0.5 text-subtlest hover:text-default"
            onClick={() => onRemove(ref.refId)}
          >
            <X className="size-3" strokeWidth={2} />
          </button>
        </span>
      ))}
    </div>
  );
}