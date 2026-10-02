import { gzipSync } from "node:zlib";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { root, modelConstants, verifyInputs } from "./inputs.mjs";
export { root, sha256, inputDigest } from "./inputs.mjs";

export const allowlist = new Set([
  "MIT", "MIT-0", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC",
  "0BSD", "Unlicense", "CC0-1.0", "Unicode-3.0", "Unicode-DFS-2016",
  "Zlib", "zlib-acknowledgement", "BSL-1.0", "OFL-1.1",
  "Apache-2.0 WITH LLVM-exception", "blessing",
]);
// Existing copyleft is disclosed, never covered by the general allowlist.
export const reviewedCopyleft = new Set([
  "rust:cssparser@0.37.0", "rust:cssparser-macros@0.7.1",
  "rust:dtoa-short@0.3.5", "rust:selectors@0.38.0", "rust:option-ext@0.2.0",
  "native:Eigen@1d8b82b0740839c0de7f1242a3585e3390ff5f33",
]);

export function readLock() {
  return JSON.parse(readFileSync(join(root, "bun.lock"), "utf8").replace(/,\s*([}\]])/g, "$1"));
}

export function productionPackages(lock = readLock()) {
  const seen = new Map();
  const visited = new Set();
  const visit = (name, parent = "") => {
    if (name.startsWith("@types/")) return;
    let scope = parent;
    let key;
    while (scope && !key) {
      const candidate = `${scope}/${name}`;
      if (lock.packages[candidate]) key = candidate;
      // A scoped package (@scope/name) is one ancestry segment.
      scope = scope.replace(/(?:^|\/)(?:@[^/]+\/)?[^/]+$/, "");
    }
    key ??= name;
    const record = lock.packages[key];
    if (!record) throw new Error(`Missing locked production dependency: ${name}`);
    const identity = record[0];
    if (visited.has(key)) return;
    visited.add(key);
    seen.set(identity, { key, identity, integrity: record.at(-1) });
    // Inventory the union of optional packages for every supported platform,
    // irrespective of what the current host installed.
    const dependencies = { ...record[2]?.dependencies, ...record[2]?.optionalDependencies };
    for (const child of Object.keys(dependencies)) visit(child, key);
    for (const child of Object.keys(record[2]?.peerDependencies ?? {})) {
      if (!record[2]?.optionalPeers?.includes(child)) visit(child, key);
    }
  };
  const ui = lock.workspaces["packages/butler-app/client/ui"];
  // These are build tools listed in dependencies, not shipped renderer code.
  const tooling = new Set(["vite", "typescript", "@vitejs/plugin-react"]);
  for (const name of Object.keys(ui.dependencies)) if (!tooling.has(name)) visit(name, ui.name);
  const electron = lock.workspaces["packages/butler-app/client/electron"];
  for (const name of Object.keys(electron.dependencies ?? {})) visit(name, electron.name);
  // npm Electron dependencies download the runtime; they are not in the App.
  const runtime = lock.packages.electron;
  seen.set(runtime[0], { key: "electron", identity: runtime[0], integrity: runtime.at(-1) });
  return [...seen.values()].sort((a, b) => a.identity.localeCompare(b.identity, "en"));
}

export function verifyProductionInventory(catalog, lock = readLock()) {
  const components = new Map(catalog.components.map((entry) => [entry.id, entry]));
  const packages = productionPackages(lock);
  for (const { identity, integrity } of packages) {
    const component = components.get(`npm:${identity}`);
    if (!component || component.integrity !== integrity) {
      throw new Error(`Missing locked license evidence: ${identity}`);
    }
  }
  return packages.length;
}

export function validateLicense(component) {
  // Supplier's complete, version-pinned distribution notices include custom
  // grants and licenses for Node/Chromium native libraries. Review on upgrade.
  if (component.id === "runtime:Electron Chromium Node suppliers@41.10.4"
      && component.license === "LicenseRef-Electron-ThirdParty") return;
  const expression = component.license?.replaceAll("/", " OR ").trim();
  if (!expression) throw new Error(`Unknown license: ${component.id}`);
  // Evaluate SPDX OR/AND expressions; choose permissive alternatives where offered.
  const tokens = expression.match(/\(|\)|\bOR\b|\bAND\b|[^\s()]+(?: WITH [^\s()]+)?/g);
  for (const token of tokens) {
    if (["(", ")", "OR", "AND"].includes(token) || allowlist.has(token)) continue;
    if (!/^(?:GPL|LGPL|AGPL)-\d\.\d-(?:only|or-later)$/.test(token) && token !== "MPL-2.0") {
      throw new Error(`License outside allowlist: ${component.id}: ${token}`);
    }
  }
  let offset = 0;
  const atom = () => {
    if (tokens[offset] !== "(") return allowlist.has(tokens[offset++]);
    offset++;
    const value = or();
    if (tokens[offset++] !== ")") throw new Error(`Invalid SPDX: ${expression}`);
    return value;
  };
  const and = () => {
    let value = atom();
    while (tokens[offset] === "AND") { offset++; const next = atom(); value = value && next; }
    return value;
  };
  const or = () => {
    let value = and();
    while (tokens[offset] === "OR") { offset++; const next = and(); value = value || next; }
    return value;
  };
  const allowed = or();
  if (offset !== tokens.length) throw new Error(`Invalid SPDX: ${expression}`);
  if (!allowed && !(expression === "MPL-2.0" && reviewedCopyleft.has(component.id))) {
    throw new Error(`License outside allowlist: ${component.id}: ${expression}`);
  }
}

export function generate(catalog = JSON.parse(readFileSync(join(root, "deploy/licenses/catalog.json"), "utf8"))) {
  verifyInputs(catalog);
  const wrapper = JSON.parse(readFileSync(join(root, "packages/butler-npm/package.json"), "utf8"));
  if (Object.keys(wrapper.dependencies ?? {}).length) throw new Error("npm wrapper dependencies must be added to bun.lock and inventoried before packaging");
  verifyProductionInventory(catalog);
  const model = catalog.components.find((entry) => entry.id.startsWith("model:Xenova/bge-m3"));
  const assets = readFileSync(join(root, "packages/butler-agent/rust/crates/butler-agent/src/host/embedding/worker/assets.rs"), "utf8");
  if (modelConstants(assets, ["REVISION"]).REVISION !== model.version) throw new Error("Embedding download revision differs from disclosed model");
  const sections = catalog.components.map((component) => {
    validateLicense(component);
    if (!component.links?.length || component.links.some((link) => {
      try { const url = new URL(link); return url.protocol !== "https:" || !url.hostname || /\s/.test(link); }
      catch { return true; }
    })) {
      throw new Error(`Missing or invalid license link: ${component.id}`);
    }
    const attribution = (component.copyright ?? []).join("\n");
    return `\n===== COMPONENT =====\n${component.name} ${component.version}\n${component.license}\n${component.links.map((link) => `License: ${link}`).join("\n")}\n${attribution}`;
  });
  return `Butler third-party disclosures\n\nComponent names, shipped versions, SPDX licenses, upstream links and available copyright lines.\nSupplier collections are disclosed as supplied; their individual versions and SPDX IDs are not consistently available.\nElectron retains its own LICENSE and LICENSES.chromium.html in its runtime.\n\n${sections.join("\n")}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const document = generate();
  if (process.argv.includes("--check")) {
    const existing = readFileSync(join(root, "deploy/licenses/THIRD_PARTY_NOTICES.txt"), "utf8");
    if (existing !== document) throw new Error("Generated notices differ; run node deploy/licenses/generate.mjs");
  } else {
    const destination = resolve(process.argv[2] ?? join(root, "deploy/licenses/THIRD_PARTY_NOTICES.txt"));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, destination.endsWith(".gz") ? gzipSync(document, { level: 9 }) : document);
  }
  console.log(`Third-party notices: ${Buffer.byteLength(document)} bytes`);
}
