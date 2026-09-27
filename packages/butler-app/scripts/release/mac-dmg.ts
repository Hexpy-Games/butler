// Builds the public Butler DMG with a Finder window layout: the App and an
// Applications link placed over a branded background. Finder reads the layout
// from the volume's `.DS_Store`, which is written here directly (buddy
// allocator + one DSDB B-tree page) so packaging never scripts Finder and works
// headless on CI runners.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

export const DMG_BACKGROUND_IMAGE = resolve(import.meta.dir, "macos", "dmg-background.tiff");
const DMG_FILE_REFERENCE_SOURCE = resolve(import.meta.dir, "macos", "dmg-file-reference.c");

// Points, measured from the top-left of the window content. The background
// artwork (macos/render-dmg-background.swift) is drawn for this geometry.
export const DMG_LAYOUT = {
  volumeName: "Butler",
  windowOrigin: { x: 200, y: 120 },
  contentSize: { width: 660, height: 400 },
  titleBarHeight: 28,
  iconSize: 128,
  textSize: 12,
  appPosition: { x: 170, y: 200 },
  applicationsPosition: { x: 490, y: 200 },
  backgroundFile: join(".background", "background.tiff"),
  // Design-system grayscale-01 (#f8f9fa), matching the artwork's base fill.
  backgroundColor: [248 / 255, 249 / 255, 250 / 255] as const,
} as const;

export class PlistReal {
  constructor(readonly value: number) {}
}

export function plistReal(value: number): PlistReal {
  return new PlistReal(value);
}

export type PlistValue =
  | string
  | number
  | boolean
  | PlistReal
  | Uint8Array
  | PlistValue[]
  | { [key: string]: PlistValue };

function isPlistDict(value: PlistValue): value is { [key: string]: PlistValue } {
  return typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array) && !(value instanceof PlistReal);
}

export function encodeBinaryPlist(root: PlistValue): Uint8Array {
  const objects: PlistValue[] = [];
  const children: number[][] = [];
  const add = (value: PlistValue): number => {
    const index = objects.length;
    objects.push(value);
    children.push([]);
    if (Array.isArray(value)) {
      children[index] = value.map(add);
    } else if (isPlistDict(value)) {
      const keys = Object.keys(value);
      const keyRefs = keys.map(add);
      const valueRefs = keys.map((key) => add(value[key]!));
      children[index] = [...keyRefs, ...valueRefs];
    }
    return index;
  };
  add(root);
  if (objects.length > 0xffff) throw new Error("binary plist has too many objects");
  const refSize = objects.length < 0x100 ? 1 : 2;
  const chunks: Uint8Array[] = [ascii("bplist00")];
  const offsets: number[] = [];
  let offset = 8;
  for (const [index, value] of objects.entries()) {
    const bytes = encodePlistObject(value, children[index]!, refSize);
    offsets.push(offset);
    chunks.push(bytes);
    offset += bytes.length;
  }
  const offsetSize = offset < 0x100 ? 1 : offset < 0x10000 ? 2 : 4;
  chunks.push(concat(offsets.map((value) => uintBytes(value, offsetSize))));
  const trailer = new Uint8Array(32);
  const view = new DataView(trailer.buffer);
  view.setUint8(6, offsetSize);
  view.setUint8(7, refSize);
  view.setBigUint64(8, BigInt(objects.length));
  view.setBigUint64(16, 0n);
  view.setBigUint64(24, BigInt(offset));
  chunks.push(trailer);
  return concat(chunks);
}

function encodePlistObject(value: PlistValue, refs: number[], refSize: number): Uint8Array {
  if (typeof value === "boolean") return Uint8Array.of(value ? 0x09 : 0x08);
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`binary plist integers must be whole numbers; use plistReal(${value})`);
    return plistInteger(value);
  }
  if (value instanceof PlistReal) {
    const bytes = new Uint8Array(9);
    bytes[0] = 0x23;
    new DataView(bytes.buffer).setFloat64(1, value.value);
    return bytes;
  }
  if (value instanceof Uint8Array) return concat([plistMarker(0x40, value.length), value]);
  if (typeof value === "string") {
    if ([...value].every((character) => character.charCodeAt(0) < 0x80)) {
      return concat([plistMarker(0x50, value.length), ascii(value)]);
    }
    return concat([plistMarker(0x60, value.length), utf16be(value)]);
  }
  const refBytes = concat(refs.map((ref) => uintBytes(ref, refSize)));
  if (Array.isArray(value)) return concat([plistMarker(0xa0, refs.length), refBytes]);
  return concat([plistMarker(0xd0, refs.length / 2), refBytes]);
}

function plistMarker(type: number, count: number): Uint8Array {
  return count < 15 ? Uint8Array.of(type | count) : concat([Uint8Array.of(type | 0x0f), plistInteger(count)]);
}

function plistInteger(value: number): Uint8Array {
  if (value < 0) {
    const bytes = new Uint8Array(9);
    bytes[0] = 0x13;
    new DataView(bytes.buffer).setBigInt64(1, BigInt(value));
    return bytes;
  }
  if (value < 0x100) return Uint8Array.of(0x10, value);
  if (value < 0x10000) return concat([Uint8Array.of(0x11), uintBytes(value, 2)]);
  if (value < 0x100000000) return concat([Uint8Array.of(0x12), uintBytes(value, 4)]);
  const bytes = new Uint8Array(9);
  bytes[0] = 0x13;
  new DataView(bytes.buffer).setBigUint64(1, BigInt(value));
  return bytes;
}

export interface DsStoreRecord {
  name: string;
  code: string;
  type: "long" | "shor" | "bool" | "blob" | "type" | "ustr";
  value: number | boolean | string | Uint8Array;
}

const DS_STORE_NODE_SIZE = 0x1000;
const DS_STORE_NODE_CAPACITY = DS_STORE_NODE_SIZE - 8;

// Allocator layout: header (0x0, 32 B), DSDB (0x40, 32 B), B-tree nodes in
// consecutive 4 KiB pages from 0x1000, then the allocator root (2 KiB). Block
// addresses encode offset | log2(size). Records that do not fit one leaf are
// split across leaves under a single internal root node.
export function encodeDsStore(records: DsStoreRecord[]): Uint8Array {
  const sorted = [...records].sort(compareDsStoreRecords);
  const encoded = sorted.map((record) => {
    const bytes = encodeDsStoreRecord(record);
    if (bytes.length + 4 > DS_STORE_NODE_CAPACITY) {
      throw new Error(`DMG .DS_Store record ${record.name}:${record.code} does not fit in one ${DS_STORE_NODE_SIZE}-byte B-tree node`);
    }
    return bytes;
  });
  const { leaves, separators } = partitionDsStoreRecords(encoded);
  const nodeCount = leaves.length === 1 ? 1 : leaves.length + 1;
  const header = { offset: 0, log2: 5 };
  const dsdb = { offset: 0x40, log2: 5 };
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({ offset: DS_STORE_NODE_SIZE * (index + 1), log2: 12 }));
  const root = { offset: DS_STORE_NODE_SIZE * (nodeCount + 1), log2: 11 };
  const rootSize = 2 ** root.log2;
  const file = new Uint8Array(4 + root.offset + rootSize);
  const view = new DataView(file.buffer);
  view.setUint32(0, 1);
  file.set(ascii("Bud1"), 4);
  view.setUint32(8, root.offset);
  view.setUint32(12, rootSize);
  view.setUint32(16, root.offset);

  // Block ids: 0 allocator root, 1 DSDB, 2.. leaves, then the internal root.
  const leafId = (index: number) => 2 + index;
  const rootNodeId = leaves.length === 1 ? leafId(0) : leafId(leaves.length);
  const dsdbStart = 4 + dsdb.offset;
  view.setUint32(dsdbStart, rootNodeId);
  view.setUint32(dsdbStart + 4, leaves.length === 1 ? 0 : 1);
  view.setUint32(dsdbStart + 8, sorted.length);
  view.setUint32(dsdbStart + 12, nodeCount);
  view.setUint32(dsdbStart + 16, DS_STORE_NODE_SIZE);

  for (const [index, leaf] of leaves.entries()) {
    const start = 4 + nodes[index]!.offset;
    view.setUint32(start, 0);
    view.setUint32(start + 4, leaf.length);
    file.set(concat(leaf), start + 8);
  }
  if (leaves.length > 1) {
    const body = concat(separators.flatMap((separator, index) => [uintBytes(leafId(index), 4), separator]));
    if (8 + body.length > DS_STORE_NODE_SIZE) throw new Error("DMG .DS_Store index node overflow");
    const start = 4 + nodes[leaves.length]!.offset;
    view.setUint32(start, leafId(leaves.length - 1));
    view.setUint32(start + 4, separators.length);
    file.set(body, start + 8);
  }

  const rootStart = 4 + root.offset;
  let position = rootStart;
  const addresses = [root, dsdb, ...nodes].map((block) => block.offset | block.log2);
  view.setUint32(position, addresses.length);
  view.setUint32(position + 4, 0);
  position += 8;
  for (const [index, address] of addresses.entries()) view.setUint32(position + index * 4, address);
  position += 256 * 4;
  view.setUint32(position, 1);
  file[position + 4] = 4;
  file.set(ascii("DSDB"), position + 5);
  view.setUint32(position + 9, 1);
  position += 13;
  for (const offsets of buddyFreeLists([header, root, dsdb, ...nodes])) {
    view.setUint32(position, offsets.length);
    for (const [index, offset] of offsets.entries()) view.setUint32(position + 4 + index * 4, offset);
    position += 4 + offsets.length * 4;
  }
  if (position - rootStart > rootSize) throw new Error("DMG .DS_Store allocator root overflow");
  return file;
}

// Fills leaves left to right; the record that overflows a leaf moves up into
// the index node as the separator between that leaf and the next one.
function partitionDsStoreRecords(records: Uint8Array[]): { leaves: Uint8Array[][]; separators: Uint8Array[] } {
  const leaves: Uint8Array[][] = [[]];
  const separators: Uint8Array[] = [];
  let used = 0;
  for (const [index, record] of records.entries()) {
    const leaf = leaves.at(-1)!;
    if (used + record.length <= DS_STORE_NODE_CAPACITY) {
      leaf.push(record);
      used += record.length;
      continue;
    }
    if (index < records.length - 1) {
      separators.push(record);
      leaves.push([]);
      used = 0;
      continue;
    }
    // The final record overflows: promote the leaf's last record instead.
    if (leaf.length < 2) throw new Error("DMG .DS_Store records cannot be arranged in a two-level B-tree");
    separators.push(leaf.pop()!);
    leaves.push([record]);
  }
  return { leaves, separators };
}

function buddyFreeLists(allocated: ReadonlyArray<{ offset: number; log2: number }>): number[][] {
  const lists: number[][] = Array.from({ length: 32 }, () => []);
  const visit = (offset: number, log2: number) => {
    const size = 2 ** log2;
    const overlapping = allocated.filter((block) => block.offset < offset + size && offset < block.offset + 2 ** block.log2);
    if (overlapping.length === 0) {
      lists[log2]!.push(offset);
      return;
    }
    if (overlapping.some((block) => block.offset === offset && block.log2 === log2)) return;
    visit(offset, log2 - 1);
    visit(offset + size / 2, log2 - 1);
  };
  visit(0, 31);
  return lists;
}

function compareDsStoreRecords(left: DsStoreRecord, right: DsStoreRecord): number {
  const leftName = left.name.toLowerCase();
  const rightName = right.name.toLowerCase();
  if (leftName !== rightName) return leftName < rightName ? -1 : 1;
  return left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
}

function encodeDsStoreRecord(record: DsStoreRecord): Uint8Array {
  if (record.code.length !== 4) throw new Error(`invalid .DS_Store record code: ${record.code}`);
  const head = concat([uintBytes(record.name.length, 4), utf16be(record.name), ascii(record.code), ascii(record.type)]);
  switch (record.type) {
    case "long":
    case "shor":
      return concat([head, uintBytes(Number(record.value), 4)]);
    case "bool":
      return concat([head, Uint8Array.of(record.value ? 1 : 0)]);
    case "type":
      if (String(record.value).length !== 4) throw new Error(`invalid .DS_Store type value: ${String(record.value)}`);
      return concat([head, ascii(String(record.value))]);
    case "blob": {
      const bytes = record.value as Uint8Array;
      return concat([head, uintBytes(bytes.length, 4), bytes]);
    }
    case "ustr": {
      const text = String(record.value);
      return concat([head, uintBytes(text.length, 4), utf16be(text)]);
    }
  }
}

function iconLocation(position: { x: number; y: number }): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, position.x);
  view.setUint32(4, position.y);
  bytes.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00], 8);
  return bytes;
}

export function dmgLayoutRecords(input: {
  appName: string;
  backgroundAlias: Uint8Array;
  backgroundBookmark: Uint8Array;
}): DsStoreRecord[] {
  const layout = DMG_LAYOUT;
  const [red, green, blue] = layout.backgroundColor;
  const { x, y } = layout.windowOrigin;
  const { width, height } = layout.contentSize;
  const windowSettings = encodeBinaryPlist({
    ContainerShowSidebar: false,
    PreviewPaneVisibility: false,
    ShowPathbar: false,
    ShowSidebar: false,
    ShowStatusBar: false,
    ShowTabView: false,
    ShowToolbar: false,
    SidebarWidth: 0,
    WindowBounds: `{{${x}, ${y}}, {${width}, ${height + layout.titleBarHeight}}}`,
  });
  const iconViewSettings = encodeBinaryPlist({
    arrangeBy: "none",
    backgroundColorBlue: plistReal(blue),
    backgroundColorGreen: plistReal(green),
    backgroundColorRed: plistReal(red),
    backgroundImageAlias: input.backgroundAlias,
    backgroundType: 2,
    gridOffsetX: plistReal(0),
    gridOffsetY: plistReal(0),
    gridSpacing: plistReal(100),
    iconSize: plistReal(layout.iconSize),
    labelOnBottom: true,
    scrollPositionX: plistReal(0),
    scrollPositionY: plistReal(0),
    showIconPreview: true,
    showItemInfo: false,
    textSize: plistReal(layout.textSize),
    viewOptionsVersion: 1,
  });
  return [
    { name: ".", code: "bwsp", type: "blob", value: windowSettings },
    { name: ".", code: "icvl", type: "type", value: "icnv" },
    { name: ".", code: "icvp", type: "blob", value: iconViewSettings },
    { name: ".", code: "pBBk", type: "blob", value: input.backgroundBookmark },
    { name: ".", code: "vSrn", type: "long", value: 1 },
    { name: ".", code: "vstl", type: "type", value: "icnv" },
    { name: "Applications", code: "Iloc", type: "blob", value: iconLocation(layout.applicationsPosition) },
    { name: input.appName, code: "Iloc", type: "blob", value: iconLocation(layout.appPosition) },
  ];
}

export function createMacDmg(input: { appBundle: string; artifactPath: string; backgroundImage?: string }): void {
  const backgroundImage = input.backgroundImage ?? DMG_BACKGROUND_IMAGE;
  if (!existsSync(backgroundImage)) throw new Error(`DMG background image is missing: ${backgroundImage}`);
  const workDir = mkdtempSync(join(tmpdir(), "butler-app-dmg-"));
  let mountPoint: string | null = null;
  try {
    const appName = basename(input.appBundle);
    const staging = join(workDir, "staging");
    mkdirSync(join(staging, ".background"), { recursive: true });
    run("ditto", [input.appBundle, join(staging, appName)], "mac app DMG staging copy failed");
    symlinkSync("/Applications", join(staging, "Applications"));
    copyFileSync(backgroundImage, join(staging, DMG_LAYOUT.backgroundFile));
    const referenceTool = compileDmgFileReferenceTool(workDir);

    const writableImage = join(workDir, "butler-rw.dmg");
    run("hdiutil", [
      "create", "-volname", DMG_LAYOUT.volumeName, "-srcfolder", staging, "-fs", "HFS+",
      "-format", "UDRW", "-size", `${imageSizeMegabytes(staging)}m`, "-ov", writableImage,
    ], "mac app DMG creation failed");
    mountPoint = attachWritableImage(writableImage);
    const background = join(mountPoint, DMG_LAYOUT.backgroundFile);
    const references = readFileReferences(referenceTool, background);
    run("chflags", ["hidden", join(mountPoint, ".background")], "mac app DMG background hide failed");
    writeFileSync(join(mountPoint, ".DS_Store"), encodeDsStore(dmgLayoutRecords({
      appName,
      backgroundAlias: references.alias,
      backgroundBookmark: references.bookmark,
    })));
    detachImage(mountPoint);
    mountPoint = null;

    rmSync(input.artifactPath, { force: true });
    run("hdiutil", [
      "convert", writableImage, "-format", "UDZO", "-imagekey", "zlib-level=9", "-o", input.artifactPath,
    ], "mac app DMG compression failed");
  } finally {
    if (mountPoint) spawnSync("hdiutil", ["detach", mountPoint, "-force"], { encoding: "utf8" });
    makeTreeRemovable(workDir);
    rmSync(workDir, { recursive: true, force: true });
  }
}

function compileDmgFileReferenceTool(workDir: string): string {
  const output = join(workDir, "dmg-file-reference");
  run("clang", [
    "-O2", "-framework", "CoreServices", "-framework", "CoreFoundation",
    DMG_FILE_REFERENCE_SOURCE, "-o", output,
  ], "DMG file reference helper build failed");
  return output;
}

function readFileReferences(tool: string, path: string): { alias: Uint8Array; bookmark: Uint8Array } {
  const result = spawnSync(tool, [path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`DMG background reference failed: ${result.stderr.trim() || result.stdout.trim()}`);
  const parsed = JSON.parse(result.stdout) as { alias?: string; bookmark?: string };
  if (!parsed.alias || !parsed.bookmark) throw new Error("DMG background reference output is incomplete");
  return { alias: Buffer.from(parsed.alias, "hex"), bookmark: Buffer.from(parsed.bookmark, "hex") };
}

function attachWritableImage(image: string): string {
  const result = spawnSync("hdiutil", [
    "attach", image, "-readwrite", "-noverify", "-noautoopen", "-nobrowse", "-plist",
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`mac app DMG attach failed: ${result.stderr.trim() || result.stdout.trim()}`);
  const mountPoint = result.stdout.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/u)?.[1];
  if (!mountPoint) throw new Error("mac app DMG attach did not report a mount point");
  return mountPoint.replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">");
}

function detachImage(mountPoint: string): void {
  let lastError = "";
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const args = attempt === 5 ? ["detach", mountPoint, "-force"] : ["detach", mountPoint];
    const result = spawnSync("hdiutil", args, { encoding: "utf8" });
    if (result.status === 0) return;
    lastError = result.stderr.trim() || result.stdout.trim();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  throw new Error(`mac app DMG detach failed: ${lastError}`);
}

function imageSizeMegabytes(root: string): number {
  let bytes = 0;
  const walk = (path: string) => {
    const stat = lstatSync(path);
    bytes += Math.ceil(stat.size / 4096) * 4096 + 4096;
    if (stat.isDirectory()) for (const entry of readdirSync(path)) walk(join(path, entry));
  };
  walk(root);
  return Math.ceil((bytes * 1.1) / (1024 * 1024)) + 16;
}

function makeTreeRemovable(root: string): void {
  if (!existsSync(root)) return;
  try {
    chmodSync(root, 0o755);
  } catch {
    return;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) makeTreeRemovable(join(root, entry.name));
  }
}

function run(command: string, args: string[], failure: string): void {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${failure}: ${result.stderr.trim() || result.stdout.trim() || result.error?.message || "unknown error"}`);
  }
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

function utf16be(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < text.length; index += 1) view.setUint16(index * 2, text.charCodeAt(index));
  return bytes;
}

function uintBytes(value: number, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let remaining = value;
  for (let index = size - 1; index >= 0; index -= 1) {
    bytes[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return bytes;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
