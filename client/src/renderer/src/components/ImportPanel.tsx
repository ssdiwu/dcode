import { uiText } from "../../../shared/ui-language.ts";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { PiImportCandidate } from "../../../../../host/src/pi-session-import.js";
import { api, errorText, type TaskBundle } from "../types";
import type { Workbench } from "../useWorkbench";

export function ImportPanel({
  onClose,
  onBusyChange,
  onImported,
  userId,
  mutateStore,
}: {
  onClose: () => void;
  onBusyChange:(busy:boolean)=>void;
  onImported: (bundle: TaskBundle) => Promise<void>;
  userId: string;
  mutateStore: Workbench["mutateStore"];
}) {
  const [candidates, setCandidates] = useState<PiImportCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [imported,setImported] = useState<Record<string,TaskBundle>>({});
  const importing=useRef(false);
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
    if (importing.current) return;
    importing.current=true;
    setBusy(candidate.sourceSessionId);
    onBusyChange(true);
    setError(null);
    let completed=false;
    let bundle=imported[candidate.sourceSessionId];
    try {
      if(!bundle){
        await api().request("piImport.preview", {
          sourceSessionId: candidate.sourceSessionId,
        });
        const created = await mutateStore<TaskBundle>("piImport.importAsTask", {
          sourceSessionId: candidate.sourceSessionId,
          scope: { kind: "user", userId },
        });
        bundle=created;
        setImported(previous=>({...previous,[candidate.sourceSessionId]:created}));
      }
      await onImported(bundle);
      completed=true;
    } catch (e) {
      setError(bundle?uiText("会话已导入，但未能打开任务：{0}", [errorText(e)]):errorText(e));
    } finally {
      importing.current=false;
      onBusyChange(false);
      setBusy(null);
      if(completed)onClose();
    }
  };
  return (
    <>
      <div className="panel-heading">
        <strong>{uiText("导入 Pi 会话")}</strong>
        <button
          className="icon-button"
          aria-label={uiText("关闭导入")}
          disabled={!!busy}
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </div>
      <div className="form-fields">
        <p className="secondary">{uiText("导入后创建独立任务，原会话保持不变。")}</p>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        {loading ? (
          <p role="status">{uiText("正在查找会话…")}</p>
        ) : candidates.length === 0 ? (
          <p>{uiText("没有可导入的会话。")}</p>
        ) : (
          candidates.map((c) => (
            <div className="import-candidate" key={c.sourceSessionId}>
              <span>
                <strong>{c.title || c.firstMessage || uiText("未命名会话")}</strong>
                <small>
                  {c.messageCount} {uiText(" 条消息")}{c.previouslyImported ? uiText(" · 已导入过") : ""}
                </small>
              </span>
              <button
                className="text-button"
                disabled={!!busy}
                onClick={() => void importOne(c)}
              >
                {busy === c.sourceSessionId ? imported[c.sourceSessionId]?uiText("正在打开…"):uiText("正在导入…") : imported[c.sourceSessionId]?uiText("打开已导入任务"):uiText("导入")}
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
}
