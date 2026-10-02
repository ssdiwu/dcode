import { uiText } from "../../../../shared/ui-language.ts";
import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { ConversationTurn } from "../../workbench/conversation-navigation";

const ITEM_HEIGHT = 40;
const OVERSCAN = 5;
const MAX_RAIL_HEIGHT = 520;

/** The existing rail is a scrollable directory of actual user inputs. */
export function ConversationRail({turns, activeId, onNavigate}: {
  turns: readonly ConversationTurn[];
  activeId: string | null;
  onNavigate: (id: string) => void;
}) {
  const navRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(MAX_RAIL_HEIGHT);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [previewTop, setPreviewTop] = useState(0);
  const hintId = useId();
  const previewId = useId();
  const activeIndex = Math.max(0, turns.findIndex(turn => turn.id === activeId));
  const selectedId = hoveredId ?? focusedId;
  const selectedIndex = turns.findIndex(turn => turn.id === selectedId);
  const maxScroll = Math.max(0, turns.length * ITEM_HEIGHT - viewportHeight);
  const visibleTop = Math.min(scrollTop, maxScroll);
  const firstVisible = Math.floor(visibleTop / ITEM_HEIGHT);
  const lastVisible = Math.ceil((visibleTop + viewportHeight) / ITEM_HEIGHT);
  const first = Math.max(0, firstVisible - OVERSCAN);
  const last = Math.min(turns.length, lastVisible + OVERSCAN);
  const focusedIndex = turns.findIndex(turn => turn.id === focusedId);
  const tabStopIndex = focusedIndex >= firstVisible && focusedIndex < lastVisible ? focusedIndex
    : activeIndex >= firstVisible && activeIndex < lastVisible ? activeIndex : firstVisible;

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => setViewportHeight(track.clientHeight || Math.min(MAX_RAIL_HEIGHT, turns.length * ITEM_HEIGHT));
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(track);
    return () => observer?.disconnect();
  }, [turns.length]);

  const reveal = (index: number) => {
    const track = trackRef.current;
    if (!track || index < 0) return;
    const height = track.clientHeight || viewportHeight;
    const top = index * ITEM_HEIGHT;
    const next = top < track.scrollTop ? top : top + ITEM_HEIGHT > track.scrollTop + height
      ? top + ITEM_HEIGHT - height : track.scrollTop;
    if (next !== track.scrollTop) {
      track.scrollTop = next;
      setScrollTop(next);
    }
  };

  useLayoutEffect(() => {
    if (turns.length) reveal(activeIndex);
  }, [activeIndex, turns.length, viewportHeight]);

  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const button = itemRefs.current.get(pendingFocus.current);
    if (button) {
      button.focus({preventScroll: true});
      pendingFocus.current = null;
    }
  }, [first, last, scrollTop, focusedId]);

  if (!turns.length) return null;

  const previewAt = (button: HTMLButtonElement) => {
    const nav = navRef.current;
    if (!nav) return;
    const buttonBounds = button.getBoundingClientRect();
    const relative = buttonBounds.top - nav.getBoundingClientRect().top + buttonBounds.height / 2;
    const edge = Math.min(80, nav.clientHeight / 2);
    setPreviewTop(Math.max(edge, Math.min(relative, nav.clientHeight - edge)));
  };
  const focusIndex = (index: number) => {
    const next = turns[index];
    if (!next) return;
    setHoveredId(null);
    setFocusedId(next.id);
    pendingFocus.current = next.id;
    reveal(index);
  };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      focusIndex(Math.min(turns.length - 1, Math.max(0, index + (event.key === "ArrowUp" ? -1 : 1))));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusIndex(event.key === "Home" ? 0 : turns.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onNavigate(turns[index].id);
    } else if (event.key === "Escape") {
      setHoveredId(null);
      setFocusedId(null);
      event.currentTarget.blur();
    }
  };

  return <nav ref={navRef} className="conversation-rail" aria-label={uiText("提问导航")}
    data-item-count={turns.length} data-rendered-item-count={last - first}
    style={{"--turn-count": turns.length} as CSSProperties}>
    <div ref={trackRef} className="conversation-rail-track" role="list" aria-label={uiText("共 {0} 条提问", [turns.length])}
      onScroll={event => {
        const track = event.currentTarget;
        const top = track.scrollTop;
        setScrollTop(top);
        setHoveredId(null);
        if (pendingFocus.current === null && focusedIndex >= 0) {
          if (focusedIndex * ITEM_HEIGHT < top || (focusedIndex + 1) * ITEM_HEIGHT > top + (track.clientHeight || viewportHeight))
            setFocusedId(null);
          else {
            const focusedButton = focusedId ? itemRefs.current.get(focusedId) : undefined;
            if (focusedButton) previewAt(focusedButton);
          }
        }
      }}>
      <div className="conversation-rail-spacer" style={{height: turns.length * ITEM_HEIGHT}}>
        {turns.slice(first, last).map((turn, offset) => {
          const index = first + offset;
          return <div key={turn.id} role="listitem" aria-posinset={index + 1} aria-setsize={turns.length}
            className="conversation-rail-item" style={{top: index * ITEM_HEIGHT}}>
            <button ref={node => {if (node) itemRefs.current.set(turn.id, node); else itemRefs.current.delete(turn.id);}}
              type="button" className="conversation-rail-button"
              aria-label={uiText("第 {0} 条提问：{1}", [index + 1, turn.question])}
              aria-current={turn.id === activeId ? "location" : undefined}
              aria-describedby={`${hintId}${focusedId === turn.id && selectedId === turn.id ? ` ${previewId}` : ""}`}
              tabIndex={index === tabStopIndex ? 0 : -1}
              onPointerEnter={event => {setHoveredId(turn.id); previewAt(event.currentTarget);}}
              onPointerLeave={() => {
                setHoveredId(null);
                const focusedButton = focusedId ? itemRefs.current.get(focusedId) : undefined;
                if (focusedButton) previewAt(focusedButton);
              }}
              onFocus={event => {setFocusedId(turn.id); previewAt(event.currentTarget);}}
              onBlur={() => setFocusedId(null)}
              onKeyDown={event => onKey(event, index)}
              onClick={() => {setFocusedId(turn.id); onNavigate(turn.id);}}>
              <span className="conversation-rail-mark" aria-hidden="true"
                data-current={turn.id === activeId || undefined}
                data-preview={turn.id === selectedId || undefined}/>
            </button>
          </div>;
        })}
      </div>
    </div>
    <span className="sr-only" id={hintId}>{uiText("上下方向键选择提问，回车或空格跳转；Home 和 End 选择首尾提问。")}</span>
    {selectedIndex >= 0 && <div role="tooltip" className="conversation-rail-preview" id={previewId}
      style={{top: previewTop}}>
      <small>{uiText("第 ")}{selectedIndex + 1} {uiText(" 条提问 · 共 ")}{turns.length} {uiText(" 条")}</small>
      <strong>{turns[selectedIndex].question}</strong>
      <p>{turns[selectedIndex].answer || uiText("暂无回答")}</p>
    </div>}
  </nav>;
}
