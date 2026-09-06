import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { currentTurn, type ConversationTurn, type TurnAnchor } from "./conversation-navigation";

export function useConversationNavigation(
  turns: readonly ConversationTurn[],
  viewportRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const anchors = useRef<TurnAnchor[]>([]);
  const jump = useRef<{id: string; top: number} | null>(null);
  const turnIds = turns.map(turn => turn.id).join("\0");

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    let frame = 0;
    const update = () => {
      if (jump.current && Math.abs(viewport.scrollTop - jump.current.top) <= 2) {
        setActiveId(jump.current.id);
        return;
      }
      jump.current = null;
      const atEnd = viewport.scrollHeight > viewport.clientHeight && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 2;
      setActiveId(atEnd ? anchors.current.at(-1)?.id ?? null : currentTurn(anchors.current, viewport.scrollTop + 32));
    };
    const measure = () => {
      const top = viewport.getBoundingClientRect().top;
      anchors.current = [...content.querySelectorAll<HTMLElement>("[data-conversation-turn]")].map(node => ({
        id: node.dataset.conversationTurn!,
        top: node.getBoundingClientRect().top - top + viewport.scrollTop,
      }));
      if (jump.current && !anchors.current.some(anchor => anchor.id === jump.current?.id)) jump.current = null;
      update();
    };
    const scroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const manualScroll = () => { jump.current = null; scroll(); };
    const keyScroll = (event: KeyboardEvent) => {
      if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(event.key)) manualScroll();
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(viewport);
    resize.observe(content);
    viewport.addEventListener("scroll", scroll, {passive: true});
    viewport.addEventListener("wheel", manualScroll, {passive: true});
    viewport.addEventListener("touchmove", manualScroll, {passive: true});
    viewport.addEventListener("keydown", keyScroll);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      viewport.removeEventListener("scroll", scroll);
      viewport.removeEventListener("wheel", manualScroll);
      viewport.removeEventListener("touchmove", manualScroll);
      viewport.removeEventListener("keydown", keyScroll);
    };
  }, [turnIds, viewportRef, contentRef]);

  const navigate = (id: string) => {
    const viewport = viewportRef.current;
    const anchor = anchors.current.find(anchor => anchor.id === id);
    if (!viewport || !anchor) return;
    const top = Math.max(0, Math.min(anchor.top - 24, viewport.scrollHeight - viewport.clientHeight));
    jump.current = {id, top};
    setActiveId(id);
    viewport.scrollTo({top, behavior: "instant"});
  };
  const goToLatest = () => {
    jump.current = null;
    const viewport = viewportRef.current;
    viewport?.scrollTo({top: viewport.scrollHeight, behavior: "instant"});
    setActiveId(anchors.current.at(-1)?.id ?? null);
  };
  return {activeId, navigate, goToLatest};
}
