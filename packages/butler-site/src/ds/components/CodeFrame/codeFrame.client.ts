/** Copy buttons for server-rendered CodeFrames. */
const COPIED_MS = 1600;

export function enhanceCodeFrames(scope: ParentNode = document) {
  for (const button of scope.querySelectorAll<HTMLButtonElement>("[data-code-copy]:not([data-ready])")) {
    button.dataset.ready = "true";
    const frame = button.closest<HTMLElement>('[data-slot="code-frame"]');
    let timer = 0;
    button.addEventListener("click", async () => {
      const code = frame?.querySelector("pre code") ?? frame?.querySelector("pre");
      if (!frame || !code) return;
      try {
        await navigator.clipboard.writeText(code.textContent ?? "");
        frame.dataset.copied = "true";
        window.clearTimeout(timer);
        timer = window.setTimeout(() => delete frame.dataset.copied, COPIED_MS);
      } catch {
        // Clipboard unavailable (insecure context or denied): the code stays selectable.
      }
    });
  }
}
