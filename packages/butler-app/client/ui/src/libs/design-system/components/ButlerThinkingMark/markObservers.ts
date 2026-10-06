/** DOM signals only. State changes wake the existing simulation; none are polled per frame. */
export function observeMark(canvas: HTMLCanvasElement, callbacks: {
  implicitTheme: boolean;
  theme(): void;
  resize(): void;
  intersection(visible: boolean): void;
  visibility(): void;
}) {
  const theme = new MutationObserver(callbacks.theme);
  if (callbacks.implicitTheme) theme.observe(canvas.closest(".theme-dark, .theme-light") ?? document.documentElement,
    { attributes: true, attributeFilter: ["class"] });
  const resize = new ResizeObserver(callbacks.resize);
  resize.observe(canvas);
  const intersection = new IntersectionObserver((entries) => callbacks.intersection(entries.some((entry) => entry.isIntersecting)));
  intersection.observe(canvas);
  document.addEventListener("visibilitychange", callbacks.visibility);
  return () => {
    theme.disconnect(); resize.disconnect(); intersection.disconnect();
    document.removeEventListener("visibilitychange", callbacks.visibility);
  };
}
