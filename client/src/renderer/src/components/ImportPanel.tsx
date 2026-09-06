import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { PiImportCandidate } from "../../../../../host/src/pi-session-import.js";
import { api, errorText, type TaskBundle } from "../types";
import type { Workbench } from "../useWorkbench";

export function ImportPanel({
  onClose,
  onImported,
  userId,
  mutateStore,
}: {
  onClose: () => void;
  onImported: (bundle: TaskBundle) => Promise<void>;
  userId: string;
  mutateStore: Workbench["mutateStore"];
}) {
  const [candidates, setCandidates] = useState<PiImportCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void api()
      .request<{ candidates: PiImportCandidate[] }>("piImport.listCandidates")
      .then((r) => {
        if (alive) {
          setCandidates(r.candidates);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (alive) {
          setError(errorText(e));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, []);
  const importOne = async (candidate: PiImportCandidate) => {
    if (busy) return;
    setBusy(candidate.sourceSessionId);
    setError(null);
    try {
      await api().request("piImport.preview", {
        sourceSessionId: candidate.sourceSessionId,
      });
      const bundle = await mutateStore<TaskBundle>("piImport.importAsTask", {
        sourceSessionId: candidate.sourceSessionId,
        scope: { kind: "user", userId },
      });
      await onImported(bundle);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <div className="panel-heading">
        <strong>导入 Pi 会话</strong>
        <button
          className="icon-button"
          aria-label="关闭导入"
          disabled={!!busy}
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </div>
      <div className="form-fields">
        <p className="secondary">导入后创建独立任务，原会话保持不变。</p>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        {loading ? (
          <p role="status">正在查找会话…</p>
        ) : candidates.length === 0 ? (
          <p>没有可导入的会话。</p>
        ) : (
          candidates.map((c) => (
            <div className="import-candidate" key={c.sourceSessionId}>
              <span>
                <strong>{c.title || c.firstMessage || "未命名会话"}</strong>
                <small>
                  {c.messageCount} 条消息
                  {c.previouslyImported ? " · 已导入过" : ""}
                </small>
              </span>
              <button
                className="text-button"
                disabled={!!busy}
                onClick={() => void importOne(c)}
              >
                {busy === c.sourceSessionId ? "正在导入…" : "导入"}
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
}
