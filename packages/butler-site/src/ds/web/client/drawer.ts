/**
 * Mobile navigation drawer: the sidebar slides over the page below the
 * desktop breakpoint. Esc, the scrim, the close button and following a link
 * close it; focus moves in on open and back to the opener on close.
 */
const DESKTOP = "(width >= 900px)";

export function enhanceDrawer() {
  const drawer = document.querySelector<HTMLElement>("[data-drawer]");
  const openers = [...document.querySelectorAll<HTMLButtonElement>("[data-drawer-open]")];
  const content = document.querySelector<HTMLElement>("[data-drawer-inert]");
  const scrim = document.querySelector<HTMLElement>("[data-drawer-scrim]");
  if (!drawer || openers.length === 0) return;
  const root = document.documentElement;
  let opener: HTMLButtonElement | null = null;

  const setOpen = (open: boolean) => {
    for (const element of [root, drawer, scrim]) {
      if (!element) continue;
      if (open) element.dataset.drawerState = "open";
      else delete element.dataset.drawerState;
    }
    for (const button of openers) button.setAttribute("aria-expanded", String(open));
    if (content) content.inert = open;
    if (open) {
      const target = drawer.querySelector<HTMLElement>("[aria-current='page']") ?? drawer.querySelector<HTMLElement>("a[href], button");
      target?.focus({ preventScroll: true });
    } else {
      opener?.focus({ preventScroll: true });
    }
  };

  for (const button of openers) {
    button.addEventListener("click", () => {
      opener = button;
      setOpen(true);
    });
  }
  for (const closer of document.querySelectorAll("[data-drawer-close]")) closer.addEventListener("click", () => setOpen(false));
  drawer.addEventListener("click", (event) => {
    if ((event.target as Element).closest("a[href]") && root.dataset.drawerState) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && root.dataset.drawerState) setOpen(false);
  });
  window.matchMedia(DESKTOP).addEventListener("change", (event) => {
    if (event.matches && root.dataset.drawerState) setOpen(false);
  });
}
