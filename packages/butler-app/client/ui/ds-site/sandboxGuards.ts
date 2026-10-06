// The DS site is also published inside a sandboxed iframe (an Artifact): there storage access, the
// History API and postMessage origins can throw instead of failing quietly. The proposal pages and the
// Butler client code they reuse call these from render and effects, so a single throw would unmount the
// whole tree ("Butler UI crashed"). Guard them once, before anything else runs; behaviour is unchanged
// wherever the APIs work.

/** History writes only mirror state into the URL; losing them must never break the page. */
for (const method of ["replaceState", "pushState"] as const) {
  const original = window.history[method].bind(window.history);
  window.history[method] = (...args: Parameters<History["replaceState"]>) => {
    try { original(...args); } catch { /* sandboxed or rate limited: the URL just stays as it is */ }
  };
}

/** Falls back to an in-memory Storage when touching localStorage / sessionStorage throws. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(String(key)) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(String(key)); },
    setItem: (key, value) => { data.set(String(key), String(value)); },
  };
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  try {
    void window[name];
  } catch {
    const fallback = memoryStorage();
    try { Object.defineProperty(window, name, { configurable: true, get: () => fallback }); } catch { /* not redefinable */ }
  }
}
