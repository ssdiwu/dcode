import { useEffect, useRef, useState } from "react";
import { Check, Copy, CircleAlert } from "lucide-react";

export function CopyButton({ text, onError }: { text: string; onError: (error: unknown) => void }) {
  const [state, setState] = useState<"idle"|"copying"|"copied"|"failed">("idle");
  const alive = useRef(true);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; clearTimeout(timer.current); };
  }, []);
  const copy = async () => {
    if (pending.current) return;
    pending.current = true;
    clearTimeout(timer.current);
    setState("copying");
    try {
      await navigator.clipboard.writeText(text);
      if (alive.current) {
        setState("copied");
        timer.current = setTimeout(() => setState("idle"), 1600);
      }
    } catch (error) {
      if (alive.current) { setState("failed"); onError(error); }
    } finally { pending.current = false; }
  };
  const label = state === "copied" ? "已复制" : state === "failed" ? "复制失败，点击重试" : state === "copying" ? "正在复制" : "复制消息";
  return <button type="button" className="icon-button copy-feedback" data-state={state} aria-label={label} title={label} disabled={state === "copying"} onClick={() => void copy()}>
    {state === "copied" ? <Check size={13}/> : state === "failed" ? <CircleAlert size={13}/> : <Copy size={13}/>}
    <span className="sr-only" role="status">{state === "copied" || state === "failed" ? label : ""}</span>
  </button>;
}
