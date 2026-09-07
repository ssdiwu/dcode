import { useSyncExternalStore } from "react";

export const uiMotion = {
  press:0.08, standard:0.18, settle:0.26,
  glide:[0.16,1,0.3,1] as const,
  spring:[0.34,1.56,0.64,1] as const,
  inertia:[0.65,0,0.35,1] as const,
};
export function installMotionTokens(root: HTMLElement) {
  for (const key of ["press","standard","settle"] as const) root.style.setProperty(`--motion-${key}`, `${uiMotion[key]*1000}ms`);
  for (const key of ["glide","spring","inertia"] as const) root.style.setProperty(`--ease-${key}`, `cubic-bezier(${uiMotion[key].join(",")})`);
}
const subscribe = (changed: () => void) => {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", changed);
  return () => media.removeEventListener("change", changed);
};
export function useMotionReduction() {
  return useSyncExternalStore(subscribe, () => window.matchMedia("(prefers-reduced-motion: reduce)").matches, () => true);
}
