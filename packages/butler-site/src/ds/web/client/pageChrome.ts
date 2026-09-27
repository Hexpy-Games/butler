/** Small page-wide enhancements: scrolled titlebar edge, platform shortcut labels, TOC highlight. */

export function trackScrolled() {
  const titlebar = document.querySelector<HTMLElement>("[data-titlebar]");
  if (!titlebar) return;
  let frame = 0;
  const update = () => {
    frame = 0;
    if (window.scrollY > 0) titlebar.dataset.scrolled = "true";
    else delete titlebar.dataset.scrolled;
  };
  window.addEventListener("scroll", () => {
    if (frame === 0) frame = requestAnimationFrame(update);
  }, { passive: true });
  update();
}

/**
 * Spoken name of a mod shortcut once its first key reads Ctrl: the authored
 * label with Command swapped for Control, or the key caps when unlabeled.
 */
export function controlKeyLabel(label: string | null, keys: string[]): string {
  if (label) return label.replace(/^(?:Command|Cmd)\b/u, "Control");
  return ["Control", ...keys.slice(1)].join(" ");
}

/** Cmd on Apple platforms, Ctrl elsewhere (the app binds mod+key the same way). */
export function labelModifierKeys() {
  const apple = /Mac|iPhone|iPad/u.test(navigator.platform || navigator.userAgent);
  if (apple) return;
  for (const kbd of document.querySelectorAll<HTMLElement>("[data-mod-key] > kbd")) {
    const keys = [...kbd.querySelectorAll<HTMLElement>(":scope > kbd")];
    kbd.setAttribute("aria-label", controlKeyLabel(kbd.getAttribute("aria-label"), keys.map((key) => key.textContent ?? "")));
    if (keys[0]) keys[0].textContent = "Ctrl";
  }
}

/** Marks the TOC link of the section the reader is in. */
export function trackTocHeading() {
  const links = [...document.querySelectorAll<HTMLAnchorElement>("[data-toc] a[href^='#']")];
  if (links.length === 0) return;
  const targets = links
    .map((link) => ({ link, heading: document.getElementById(decodeURIComponent(link.hash.slice(1))) }))
    .filter((entry): entry is { link: HTMLAnchorElement; heading: HTMLElement } => entry.heading !== null);
  let frame = 0;
  const update = () => {
    frame = 0;
    const offset = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
    const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    let current = atEnd ? targets.at(-1) : undefined;
    for (const entry of current ? [] : targets) {
      if (entry.heading.getBoundingClientRect().top - offset <= 1) current = entry;
    }
    for (const { link } of targets) {
      if (current?.link.hash === link.hash) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
  };
  window.addEventListener("scroll", () => {
    if (frame === 0) frame = requestAnimationFrame(update);
  }, { passive: true });
  update();
}
