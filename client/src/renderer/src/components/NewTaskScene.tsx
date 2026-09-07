import { Component, lazy, Suspense, useSyncExternalStore, type ReactNode } from "react";

const OriginalScene = lazy(() => import("./StructureFlowScene"));
const subscribeVisibility = (changed: () => void) => {
  document.addEventListener("visibilitychange", changed);
  return () => document.removeEventListener("visibilitychange", changed);
};
const subscribeMotion = (changed: () => void) => {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", changed);
  return () => media.removeEventListener("change", changed);
};

class SceneBoundary extends Component<{ children: ReactNode }, { unavailable: boolean }> {
  state = { unavailable: false };
  static getDerivedStateFromError() { return { unavailable: true }; }
  render() { return this.state.unavailable ? null : this.props.children; }
}

/** Optional atmosphere only. A static page is the accessible/unavailable fallback. */
export function NewTaskScene() {
  const reduced = useSyncExternalStore(subscribeMotion, () => window.matchMedia("(prefers-reduced-motion: reduce)").matches, () => true);
  const visible = useSyncExternalStore(subscribeVisibility, () => !document.hidden, () => false);
  const supported = typeof window.WebGLRenderingContext !== "undefined";
  return <div className="new-task-ambient" aria-hidden="true">
    {visible && !reduced && supported && <SceneBoundary><Suspense fallback={null}><OriginalScene /></Suspense></SceneBoundary>}
  </div>;
}
