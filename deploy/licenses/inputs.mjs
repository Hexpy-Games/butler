import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const modelInputs = {
  "packages/butler-agent/rust/crates/butler-memory/src/cognition/embedding.rs":
    ["MODEL_ID", "TOKENIZER_VERSION", "ORT_WRAPPER_VERSION"],
  "packages/butler-agent/rust/crates/butler-agent/src/host/embedding/worker/assets.rs":
    ["REVISION", "MODEL_ROOT"],
};
export const refreshCommand = "python3 deploy/licenses/refresh.py && node deploy/licenses/generate.mjs";
export const noticeDirectories = [
  "packages/butler-app/client/ui/src/libs/design-system/fonts",
  "packages/butler-app/client/ui/src/libs/design-system/components/ProviderLogo/logos",
  "packages/butler-agent/rust/crates/butler-core/src/js_date/parse",
  "packages/butler-agent/rust/crates/butler-agent/resources",
  "packages/butler-agent/rust/crates/butler-platform/data", "packages/butler-agent/resources",
];

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function withoutRustComments(content) {
  // Rust block comments nest; quote characters inside comments are plain text.
  let depth = 0;
  let code = "";
  for (let index = 0; index < content.length; index++) {
    const pair = content.slice(index, index + 2);
    if (pair === "/*") {
      if (!depth) code += " ";
      depth++;
      index++;
    } else if (depth) {
      if (pair === "*/") { depth--; index++; }
    } else if (pair === "//") {
      const end = content.indexOf("\n", index);
      index = end === -1 ? content.length : end - 1;
      code += " ";
    } else if (content[index] === '"') {
      const start = index++;
      while (index < content.length && content[index] !== '"') {
        if (content[index] === "\\") index++;
        index++;
      }
      code += content.slice(start, index + 1);
    } else code += content[index];
  }
  if (depth) throw new Error("Unterminated Rust comment");
  return code;
}

export function modelConstants(content, names) {
  const code = withoutRustComments(content);
  return Object.fromEntries(names.map((name) => {
    const matches = [...code.matchAll(new RegExp(`\\bconst\\s+${name}\\s*:\\s*&str\\s*=\\s*("(?:\\\\.|[^"\\\\])*")\\s*;`, "g"))];
    if (matches.length !== 1) throw new Error(`Missing or ambiguous model identity constant: ${name}`);
    return [name, JSON.parse(matches[0][1])];
  }));
}

export function inputDigest(file, base = root) {
  const content = readFileSync(join(base, file));
  if (modelInputs[file]) return sha256(JSON.stringify(modelConstants(content.toString(), modelInputs[file])));
  // Publishing stamps the wrapper version without changing its dependency closure.
  if (file === "packages/butler-npm/package.json") {
    const manifest = JSON.parse(content);
    delete manifest.version;
    return sha256(JSON.stringify(Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b, "en")))));
  }
  return sha256(content);
}

function collectFiles(base, directory, accept) {
  const files = [];
  for (const entry of readdirSync(join(base, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory() && !["target", "node_modules", ".git"].includes(entry.name)) {
      files.push(...collectFiles(base, path, accept));
    } else if (entry.isFile() && accept(entry.name)) files.push(path);
  }
  return files;
}

export function inputFiles(base = root) {
  const files = ["bun.lock", "packages/butler-agent/rust/Cargo.lock",
    "packages/butler-agent/rust/rust-toolchain.toml",
    "packages/butler-agent/rust/scripts/static-ort.lock.json",
    "deploy/licenses/generate.mjs", "deploy/licenses/inputs.mjs",
    "deploy/licenses/refresh.py", "deploy/licenses/disclosure.py",
    "packages/butler-npm/package.json", "packages/butler-app/client/ui/package.json",
    "packages/butler-app/client/electron/package.json", ...Object.keys(modelInputs)];
  files.push(...collectFiles(base, "packages/butler-agent/rust", (name) => name === "Cargo.toml"));
  for (const directory of noticeDirectories) {
    files.push(...collectFiles(base, directory, (name) => /^(licen[cs]e|copying|notice|copyright)([._-]|$)/i.test(name)));
  }
  return [...new Set(files)].sort();
}

export function verifyInputs(catalog, base = root) {
  const current = new Set(inputFiles(base));
  const changed = [...new Set([...current, ...Object.keys(catalog.inputs)])].filter((file) => {
    if (!current.has(file) || !Object.hasOwn(catalog.inputs, file)) return true;
    try { return inputDigest(file, base) !== catalog.inputs[file]; }
    catch { return true; } // Missing files or unparseable identities must fail closed.
  });
  if (changed.length) throw new Error(`Notices inventory is stale: ${changed.sort().join(", ")}; run ${refreshCommand}`);
}
