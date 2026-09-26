import { Component } from "react";
import { createRoot } from "react-dom/client";
import { StructureFlowCollection } from "@designcodeio/threeui";
import "@designcodeio/threeui/style.css";

export function Scene() {
  return (
    <div className="shader-frame">
      <StructureFlowCollection
        variant="structure-flow"
        speed={1.00}
        pointSize={0.080}
        opacity={0.40}
        maskStart={0.20}
        maskSolid={0.50}
      />
    </div>
  );
}

class SceneBoundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <p className="scene-unavailable" role="status">背景未能加载，请刷新页面重试。</p>
      : this.props.children;
  }
}

// The prototype owns page lifetime; the registered component owns all rendering.
const mounts = ["#newtask-scene"].map(selector => {
  const element = document.querySelector<HTMLElement>(selector)!;
  return { element, root: createRoot(element), active: false };
});
function syncScenes() {
  for (const mount of mounts) {
    const active = !document.hidden && !mount.element.closest<HTMLElement>("[data-page]")!.hidden;
    if (active === mount.active) continue;
    mount.active = active;
    mount.root.render(active ? <SceneBoundary><Scene /></SceneBoundary> : null);
  }
}
const observer = new MutationObserver(syncScenes);
document.querySelectorAll("[data-page]").forEach(page => observer.observe(page, {attributes:true,attributeFilter:["hidden"]}));
document.addEventListener("visibilitychange", syncScenes);
syncScenes();
