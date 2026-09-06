import { useId, useState, type CSSProperties, type KeyboardEvent } from "react";
import { turnIndexAtPosition, type ConversationTurn } from "../../workbench/conversation-navigation";

/** One continuous hit target keeps dense histories usable, as in the Swift rail. */
export function ConversationRail({turns, activeId, onNavigate}: {
  turns: readonly ConversationTurn[];
  activeId: string | null;
  onNavigate: (id: string) => void;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [keyboard, setKeyboard] = useState<number | null>(null);
  const hintId = useId();
  const previewId = useId();
  const current = Math.max(0, turns.findIndex(turn => turn.id === activeId));
  const selected = Math.min(turns.length - 1, hovered ?? keyboard ?? current);
  const showingPreview = hovered !== null || keyboard !== null;
  if (!turns.length) return null;
  const pointIndex = (clientY: number, element: HTMLElement) => {
    const bounds = element.getBoundingClientRect();
    return Math.max(0, turnIndexAtPosition(clientY - bounds.top - 8, bounds.height - 16, turns.length));
  };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      setHovered(null);
      setKeyboard(Math.min(turns.length - 1, Math.max(0, selected + (event.key === "ArrowUp" ? -1 : 1))));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault(); setHovered(null); setKeyboard(event.key === "Home" ? 0 : turns.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); onNavigate(turns[selected].id);
    } else if (event.key === "Escape") {
      setHovered(null); setKeyboard(null); event.currentTarget.blur();
    }
  };
  return <nav className="conversation-rail" aria-label="对话导航" style={{"--turn-count": turns.length} as CSSProperties}>
    <button type="button" className="conversation-rail-track"
      aria-label={`对话导航，第 ${selected + 1} 轮，共 ${turns.length} 轮`}
      aria-describedby={`${hintId}${showingPreview ? ` ${previewId}` : ""}`}
      onPointerMove={event => setHovered(pointIndex(event.clientY, event.currentTarget))}
      onPointerLeave={() => setHovered(null)}
      onFocus={() => setKeyboard(current)} onBlur={() => setKeyboard(null)} onKeyDown={onKey}
      onClick={event => {const index = event.detail === 0 ? selected : pointIndex(event.clientY, event.currentTarget); if (turns[index]) {setKeyboard(index); onNavigate(turns[index].id);}}}
    >
      {turns.map((turn, index) => <span key={turn.id} aria-hidden="true" className="conversation-rail-mark" data-current={turn.id === activeId || undefined} data-preview={showingPreview && index === selected || undefined}/>)}
    </button>
    <span className="sr-only" id={hintId}>上下方向键选择轮次，回车或空格跳转；Home 和 End 选择首尾轮次。</span>
    {showingPreview && turns[selected] && <div role="tooltip" className="conversation-rail-preview" id={previewId}>
      <small>第 {selected + 1} 轮 · 共 {turns.length} 轮</small>
      <strong>{turns[selected].question}</strong>
      <p>{turns[selected].answer || "暂无回答"}</p>
    </div>}
  </nav>;
}
