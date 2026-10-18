// 命名长期任务表单只保留编辑意图；正式任务、唯一主会话及保存回执由应用层持有。
// 结果未知只能按原 operationId 只读查回，不能把再次点击“创建”当成未发生的重试。

import { useEffect, useRef, useState } from "react";
import type { CreatedTask, TaskCreationIntent } from "@/contracts";
import { Button } from "./Button";
import { Dialog } from "./Menu";
import { useT } from "../i18n";

export function TaskDialog({
  workspaceId,
  workspaceName,
  initialIntent,
  restoreFocusTo,
  onIntentChange,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  workspaceName: string;
  initialIntent?: TaskCreationIntent | null;
  restoreFocusTo?: HTMLElement | null;
  /** 同次创建的界面意图须在发请求前可靠保留；它不代表任务已创建。 */
  onIntentChange: (intent: TaskCreationIntent | null, operationId: string) => boolean;
  onClose: () => void;
  onCreated: (task: CreatedTask) => void;
}) {
  const t = useT();
  const operation = useRef(initialIntent?.operationId ?? crypto.randomUUID());
  const submittedTitle = useRef<string | null>(initialIntent?.title ?? null);
  const alive = useRef(true);
  const flight = useRef(false);
  const [title, setTitle] = useState(initialIntent?.title ?? "");
  const [readback, setReadback] = useState(Boolean(initialIntent));
  const [saving, setSaving] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [invalidTarget, setInvalidTarget] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const close = () => {
    // 退出表单不撤销已发出的保存。迟到回执仍由应用事实与同次查回处理，
    // 这一个已退出表单不能再把用户从后来选择的位置拉走。
    alive.current = false;
    onClose();
  };

  const submit = async () => {
    if (flight.current || blocked || invalidTarget || (!readback && !title.trim())) return;
    flight.current = true;
    setSaving(true);
    setError(null);
    try {
      if (readback) {
        const result = await window.dcode.lookupTaskCreation({ operationId: operation.current });
        if (!alive.current) return;
        if (result.status === "created") {
          onIntentChange(null, operation.current);
          onCreated(result.task);
          close();
        } else if (result.status === "not-found") {
          onIntentChange(null, operation.current);
          setReadback(false);
          setError(t("task.notSaved"));
        } else {
          setError(t("task.saveUnknown"));
        }
        return;
      }

      const nextTitle = title.trim();
      // 可靠确认未创建后若改了名称，这是新意图；旧创建身份不能携带另一份内容。
      if (submittedTitle.current !== null && submittedTitle.current !== nextTitle) operation.current = crypto.randomUUID();
      submittedTitle.current = nextTitle;
      const intent = { operationId: operation.current, workspaceId, title: nextTitle };
      if (!onIntentChange(intent, operation.current)) {
        setError(t("task.intentNotSaved"));
        return;
      }
      const created = await window.dcode.createTask({ ...intent, parentId: null });
      if (!alive.current) return;
      onIntentChange(null, operation.current);
      onCreated(created);
      close();
    } catch (cause) {
      if (!alive.current) return;
      const code = cause instanceof Error ? cause.message : "";
      if (code.includes("task-create-save-failed")) {
        onIntentChange(null, operation.current);
        setError(t("task.saveFailed"));
      } else if (code.includes("task-create-blocked")) {
        // 排队的另一项创建尚未核清；本次请求可靠未写盘，不把它误标为自身保存未知。
        setBlocked(true);
        setError(t("task.blocked"));
      } else if (code.includes("task-create-invalid-target")) {
        onIntentChange(null, operation.current);
        setInvalidTarget(true);
        setError(t("task.invalidTarget"));
      } else {
        // 传输中断、保存结果未知或同身份冲突都不能另起一次创建。
        setReadback(true);
        setError(t(code.includes("task-create-conflict") ? "task.creationChanged" : "task.saveUnknown"));
      }
    } finally {
      flight.current = false;
      if (alive.current) setSaving(false);
    }
  };

  return (
    <Dialog
      title={t("nav.newLongTask")}
      onClose={close}
      restoreFocusTo={restoreFocusTo}
      actions={<>
        <Button variant="ghost" onClick={close}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={saving || blocked || invalidTarget || (!readback && !title.trim())}
          aria-busy={saving} onClick={() => void submit()}>
          {t(saving ? readback ? "task.checking" : "task.saving" : readback ? "task.check" : "common.create")}
        </Button>
      </>}
    >
      <p className="mb-3 text-ui-sm text-subtle">{t("task.destination", { name: workspaceName })}</p>
      <label className="flex flex-col gap-1 text-ui-sm">
        {t("nav.taskNamePlaceholder")}
        <input
          value={title}
          maxLength={120}
          disabled={saving || readback || blocked || invalidTarget}
          onChange={(event) => { setTitle(event.target.value); setError(null); }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={t("nav.taskNamePlaceholder")}
          className="input-surface w-full h-8 rounded-lg border border-border bg-input px-2.5 text-ui-base"
        />
      </label>
      <p className="mt-2 text-ui-sm text-subtlest">{t("nav.longTermHint")}</p>
      {error && <p role="alert" className="mt-2 text-ui-sm text-destructive">{error}</p>}
    </Dialog>
  );
}
