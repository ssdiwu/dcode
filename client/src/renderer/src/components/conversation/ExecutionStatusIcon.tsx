import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, CircleHelp, LoaderCircle, Square, Pause } from "lucide-react";
import type { ExecutionTurn } from "../../workbench/execution-process";

export function ExecutionStatusIcon({state}:{state:ExecutionTurn["status"]}) {
  const previous = useRef(state);
  const [completing, setCompleting] = useState(false);
  useEffect(() => {
    const changed = previous.current === "running" && state === "complete";
    previous.current = state;
    setCompleting(changed);
    if (changed) {
      const timer = setTimeout(() => setCompleting(false), 260);
      return () => clearTimeout(timer);
    }
  }, [state]);
  return <span className="execution-state-icon" data-state={state} data-completing={completing || undefined} aria-hidden="true">
    {state === "running" ? <LoaderCircle className="spinner" size={13}/> : state === "complete" ? <Check size={13}/> : state === "error" ? <CircleAlert size={13}/> : state === "interrupted" ? <Pause size={13}/> : state === "unknown" ? <CircleHelp size={13}/> : <Square size={11}/>}
  </span>;
}
