/**
 * Docs search on the Pagefind index (built by `pagefind --site dist`).
 * Opens from any [data-search-open] control or Cmd/Ctrl+K; the header mark
 * thinks while results load.
 */
import { THINKING_EVENT } from "../hooks/useBrandActivity";

interface PagefindResult {
  url: string;
  excerpt: string;
  meta: { title?: string };
  /** Matches grouped under the page's headings (url carries the #anchor). */
  sub_results?: Array<{ title: string; url: string; excerpt: string }>;
}

interface Pagefind {
  options(options: { baseUrl: string }): Promise<void>;
  debouncedSearch(query: string): Promise<{ results: Array<{ data(): Promise<PagefindResult> }> } | null>;
}

const MAX_RESULTS = 8;
const COPY = { loading: "찾는 중…", empty: "결과 없음", unavailable: "검색 색인 없음 · 빌드 후 사용 가능" };

let pagefind: Promise<Pagefind | null> | undefined;

function loadPagefind(base: string): Promise<Pagefind | null> {
  // Resolve against the page, not this module, so a relative base also works.
  const bundle = new URL(`${base}pagefind/pagefind.js`, document.baseURI).href;
  pagefind ??= import(/* @vite-ignore */ bundle)
    .then(async (module: Pagefind) => {
      await module.options({ baseUrl: base });
      return module;
    })
    .catch(() => null);
  return pagefind;
}

/**
 * Results on the current page become in-page anchors (no reload). A page is
 * addressed as its directory (trailing slash) or as that directory's index.html.
 */
function localHref(url: string): string {
  const target = new URL(url, document.baseURI);
  const directory = location.pathname.replace(/[^/]*$/u, "");
  const samePage = target.pathname === location.pathname || target.pathname.replace(/index\.html$/u, "") === directory;
  return samePage && target.hash ? target.hash : url;
}

function thinking(active: boolean) {
  window.dispatchEvent(new CustomEvent(THINKING_EVENT, { detail: active }));
}

export function enhanceSearch() {
  const dialog = document.querySelector<HTMLDialogElement>("[data-search-dialog]");
  const input = dialog?.querySelector<HTMLInputElement>("[data-search-input]");
  const status = dialog?.querySelector<HTMLElement>("[data-search-status]");
  const list = dialog?.querySelector<HTMLUListElement>("[data-search-list]");
  const template = dialog?.querySelector<HTMLTemplateElement>("[data-search-item]");
  if (!dialog || !input || !status || !list || !template) return;
  const base = dialog.dataset.base ?? "/";
  let active = -1;

  const links = () => [...list.querySelectorAll<HTMLAnchorElement>("a")];
  const setActive = (index: number) => {
    const items = links();
    active = items.length === 0 ? -1 : (index + items.length) % items.length;
    items.forEach((link, position) => (link.dataset.active = String(position === active)));
    items[active]?.scrollIntoView({ block: "nearest" });
  };

  const render = (results: PagefindResult[]) => {
    list.replaceChildren(...results.map((result) => {
      const item = template.content.firstElementChild!.cloneNode(true) as HTMLLIElement;
      const link = item.querySelector("a")!;
      const page = result.meta.title ?? result.url;
      // Deep-link to the best-matching heading when it is not the page itself.
      const section = result.sub_results?.find((sub) => sub.url.includes("#"));
      link.href = localHref(section?.url ?? result.url);
      link.children[0].textContent = section ? `${page} › ${section.title}` : page;
      link.children[1].innerHTML = section?.excerpt ?? result.excerpt;
      return item;
    }));
    setActive(0);
  };

  const search = async () => {
    const query = input.value.trim();
    if (!query) {
      status.textContent = "";
      list.replaceChildren();
      return;
    }
    status.textContent = COPY.loading;
    thinking(true);
    try {
      const engine = await loadPagefind(base);
      if (!engine) {
        status.textContent = COPY.unavailable;
        return;
      }
      const response = await engine.debouncedSearch(query);
      if (!response || input.value.trim() !== query) return;
      const results = await Promise.all(response.results.slice(0, MAX_RESULTS).map((result) => result.data()));
      status.textContent = results.length === 0 ? COPY.empty : "";
      render(results);
    } catch {
      status.textContent = COPY.unavailable;
      list.replaceChildren();
    } finally {
      thinking(false);
    }
  };

  // Following an in-page result closes the dialog.
  list.addEventListener("click", (event) => {
    if ((event.target as Element).closest("a")?.getAttribute("href")?.startsWith("#")) dialog.close();
  });

  const open = () => {
    if (dialog.open) return;
    dialog.showModal();
    input.select();
    void loadPagefind(base);
  };

  for (const trigger of document.querySelectorAll("[data-search-open]")) trigger.addEventListener("click", open);
  input.addEventListener("input", () => void search());
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(active + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      links()[active]?.click();
    }
  });
  // A click on the backdrop (outside the dialog box) closes it.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (dialog.open) dialog.close();
      else open();
    }
  });
}
