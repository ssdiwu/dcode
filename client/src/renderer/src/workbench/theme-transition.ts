import { flushSync } from "react-dom";

/** The persisted preference and nativeTheme remain authoritative. No local theme store. */
export async function changeThemeFromButton(button: HTMLElement, save: () => Promise<unknown>) {
  const doc = document.documentElement;
  const rect = button.getBoundingClientRect();
  const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    await save();
    return;
  }
  doc.classList.add("theme-changing");
  const transition = document.startViewTransition(async () => {
    await save();
    // Chromium suspends rendering here: never await rAF in this callback.
    // IPC already acknowledged nativeTheme; commit pending preference UI now.
    flushSync(() => {});
  });
  try {
    await transition.ready;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    doc.animate({clipPath:[`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`]}, {
      duration:400, easing:"cubic-bezier(0.16, 1, 0.3, 1)", pseudoElement:"::view-transition-new(root)",
    });
    await transition.finished;
  } catch {
    // A skipped visual transition must not swallow a failed preference mutation.
    await transition.updateCallbackDone;
  } finally {
    doc.classList.remove("theme-changing");
  }
}
