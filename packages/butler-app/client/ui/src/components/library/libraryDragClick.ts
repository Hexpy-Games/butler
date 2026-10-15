/** Suppress only the click synthesized immediately after a pointer drop. */
export function suppressDragClick() {
  const prevent = (event: MouseEvent) => { event.stopPropagation(); event.preventDefault(); };
  window.addEventListener("click", prevent, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", prevent, true), 0);
}
