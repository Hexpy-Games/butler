// Smoke-only probes: Vite instruments served modules; product sources stay clean.
const probes = `
function __documentProfile<T>(name: string, run: () => T): T {
  const start = performance.now();
  try { return run(); } finally { performance.measure("document:" + name, { start, end: performance.now() }); }
}
async function __documentProfileAsync<T>(name: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await run(); } finally { performance.measure("document:" + name, { start, end: performance.now() }); }
}
`;
function replace(source: string, before: string, after: string) {
  if (!source.includes(before)) throw new Error(`Document probe anchor missing: ${before}`);
  return source.replace(before, after);
}
export function documentProfilePlugin() {
  return { name: "document-profile", enforce: "pre" as const, transform(source: string, id: string) {
    if (!id.includes("/components/documents/") || !/\.(tsx?|jsx?)$/u.test(id)) return;
    if (id.endsWith("/documentMarkdown.ts")) {
      source = replace(source, "fromMarkdown(markdown).children", '__documentProfile("mdast parse", () => fromMarkdown(markdown)).children');
      source = replace(source, "function importPart(", "function importPartContent(");
      source += `\nconst importPart: typeof importPartContent = (raw, part) => __documentProfile(
        part.type === "code" && part.lang === "blocks" ? "part blocks" : part.type === "paragraph" && part.children[0]?.type === "image" ? "part image" : "part text or raw",
        () => importPartContent(raw, part));\n`;
    } else if (id.endsWith("/DocumentBody.tsx")) {
      source = replace(source, "source.current = importDocument(body);", 'source.current = __documentProfile("import total", () => importDocument(body));');
      source = replace(source, "editor.update(() => {", '__documentProfile("Lexical update", () => editor.update(() => {');
      source = replace(source, '{ tag: "document-load", discrete: true });', '{ tag: "document-load", discrete: true }));');
    } else if (id.endsWith("/DocumentNodes.tsx")) {
      source = replace(source, "import { createContext, useContext,", "import { Profiler, createContext, useContext,");
      source = replace(source, 'function decorateImages(', 'function decorateImagesContent(');
      source += '\nconst decorateImages: typeof decorateImagesContent = (...args) => __documentProfile("asset URLs", () => decorateImagesContent(...args));\n';
      source = replace(source, 'const asset = assets.find(asset => image?.type === "image" && asset.id === image.url);', 'const asset = __documentProfile("asset URLs", () => assets.find(asset => image?.type === "image" && asset.id === image.url));');
      source = replace(source, 'return <Unit nodeKey={this.__key} raw={this.__raw} type={this.getType()} />;', 'return <Profiler id={this.__key} onRender={(_id, _phase, duration) => { const end = performance.now(); performance.measure("document:decorator React render", { start: end - duration, end }); }}><Unit nodeKey={this.__key} raw={this.__raw} type={this.getType()} /></Profiler>;');
    } else if (id.endsWith("/documentApi.ts")) {
      const line = source.split("\n").find(line => line.startsWith("export const readDocument ="));
      if (!line) throw new Error("Document fetch probe anchor missing");
      source = replace(source, line, line.replace("=> api<EditableDocument>(", '=> __documentProfileAsync("fetch and JSON", () => api<EditableDocument>(').replace(/\);$/u, "));"));
    } else return;
    return { code: source + probes, map: null };
  } };
}
