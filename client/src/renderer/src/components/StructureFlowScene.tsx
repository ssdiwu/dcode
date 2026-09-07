import { useEffect, useRef, useState } from "react";
import { StructureFlowCollection } from "../vendor/threeui/src/shaders/structure-flow/StructureFlowCollection";
import "../vendor/threeui/src/shaders/threeui.css";

export default function StructureFlowScene() {
  const host = useRef<HTMLDivElement>(null);
  const [lost, setLost] = useState(false);
  useEffect(() => {
    const node = host.current;
    const unavailable = () => setLost(true);
    node?.addEventListener("webglcontextlost", unavailable, true);
    return () => node?.removeEventListener("webglcontextlost", unavailable, true);
  }, []);
  return <div className="shader-frame" ref={host}>
    {!lost && <StructureFlowCollection variant="structure-flow" speed={1.00} pointSize={0.080} opacity={0.40} maskStart={0.20} maskSolid={0.50} />}
  </div>;
}
