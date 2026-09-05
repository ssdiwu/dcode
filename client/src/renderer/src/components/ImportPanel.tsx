import { useEffect, useState } from "react";
import { api } from "../types";

/**
 * 导入 Pi 会话面板：listCandidates 只读发现 → importAsTask 单向导入为
 * 新 D Code Task（含协调会话）。来源 JSONL 不改写。
 */
interface Candidate {
  sessionId: string;
  title?: string;
  cwd?: string;
  mtime?: string;
}

export function ImportPanel({
  onClose,
  onImported,
  userId,
}: {
  onClose: () => void;
  onImported: () => void;
  userId: string;
}) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api()
      .request("piImport.listCandidates")
      .then(value => {
        if (!alive) return;
        const result = value as { candidates?: Candidate[] };
        setCandidates(result.candidates ?? []);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (!alive) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const importCandidate = async (candidate: Candidate) => {
    setBusyId(candidate.sessionId);
    setError(null);
    try {
      const preview = (await api().request("piImport.preview", {
        sessionId: candidate.sessionId,
      })) as { storeRevision?: number };
      await api().request("piImport.importAsTask", {
        requestId: `web-import-${Date.now()}-${candidate.sessionId}`,
        expectedStoreRevision: preview.storeRevision,
        sessionId: candidate.sessionId,
        scope: { kind: "user", userId },
      });
      onImported();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusyId(null);
    }
  };

  return (
    <div
      className="w-[min(560px,92%)] rounded-xl border border-line bg-raised p-4 shadow-2xl"
      onClick={event => event.stopPropagation()}
    >
      <div className="flex items-center">
        <strong className="text-[14px]">导入 Pi 会话</strong>
        <button
          onClick={onClose}
          className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-hint hover:bg-ink/5"
        >
          关闭
        </button>
      </div>
      <p className="mt-1 text-[11px] leading-4 text-hint">
        单向导入：来源 JSONL 不改写；导入后成为新的 D Code
        任务与协调会话，独立演化。
      </p>
      <div className="mt-3 max-h-[320px] space-y-1.5 overflow-y-auto">
        {loading ? (
          <p className="text-[12px] text-muted">正在发现可导入会话…</p>
        ) : error ? (
          <p className="text-[12px] text-warn">{error}</p>
        ) : candidates.length === 0 ? (
          <p className="text-[12px] text-muted">没有发现可导入的 Pi 会话。</p>
        ) : (
          candidates.map(candidate => (
            <div
              key={candidate.sessionId}
              className="flex items-center gap-3 rounded-lg border border-line px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-[12.5px]">
                {candidate.title || candidate.sessionId}
              </span>
              <button
                onClick={() => void importCandidate(candidate)}
                disabled={busyId === candidate.sessionId}
                className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[11px] text-accent hover:bg-accent-fill disabled:opacity-40"
              >
                {busyId === candidate.sessionId ? "导入中…" : "导入为任务"}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
