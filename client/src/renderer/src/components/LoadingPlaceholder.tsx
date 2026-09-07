import { useEffect, useState } from "react";

/** Shows geometry only while a real read is pending; never delays the result. */
export function LoadingPlaceholder({ label }: { label: string }) {
  const [showShapes, setShowShapes] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShowShapes(true), 160);
    return () => clearTimeout(timer);
  }, []);
  return <div className="loading-placeholder" role="status" aria-busy="true">
    <span className="loading-label">{label}</span>
    {showShapes && <div className="loading-shapes" aria-hidden="true"><i/><i/><i/></div>}
  </div>;
}
