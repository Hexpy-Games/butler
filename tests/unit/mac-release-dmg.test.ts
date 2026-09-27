import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DMG_LAYOUT,
  dmgLayoutRecords,
  encodeBinaryPlist,
  encodeDsStore,
  plistReal,
  type DsStoreRecord,
} from "../../packages/butler-app/scripts/release/mac-dmg.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Minimal reader for the Finder .DS_Store layout (Bud1 buddy allocator + DSDB
// B-tree), used to prove the encoder output is structurally valid.
interface ParsedDsStore {
  records: DsStoreRecord[];
  blocks: number[];
  free: number[][];
  levels: number;
  nodes: number;
}

function readDsStore(bytes: Uint8Array): ParsedDsStore {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0)).toBe(1);
  expect(Buffer.from(bytes.subarray(4, 8)).toString("latin1")).toBe("Bud1");
  const rootOffset = view.getUint32(8);
  const rootSize = view.getUint32(12);
  expect(view.getUint32(16)).toBe(rootOffset);
  let position = rootOffset + 4;
  const count = view.getUint32(position);
  position += 8;
  const blocks = Array.from({ length: count }, (_, index) => view.getUint32(position + index * 4));
  position += 4 * Math.ceil(count / 256) * 256;
  const tocCount = view.getUint32(position);
  position += 4;
  const toc = new Map<string, number>();
  for (let index = 0; index < tocCount; index += 1) {
    const length = bytes[position]!;
    const name = Buffer.from(bytes.subarray(position + 1, position + 1 + length)).toString("latin1");
    toc.set(name, view.getUint32(position + 1 + length));
    position += 5 + length;
  }
  const free: number[][] = [];
  for (let index = 0; index < 32; index += 1) {
    const entries = view.getUint32(position);
    free.push(Array.from({ length: entries }, (_, entry) => view.getUint32(position + 4 + entry * 4)));
    position += 4 + entries * 4;
  }
  expect(position - rootOffset - 4).toBeLessThanOrEqual(rootSize);
  const blockOffset = (id: number) => (blocks[id]! & ~0x1f) + 4;
  const blockEnd = (id: number) => blockOffset(id) + 2 ** (blocks[id]! & 0x1f);
  const dsdb = blockOffset(toc.get("DSDB")!);
  const rootNode = view.getUint32(dsdb);
  const levels = view.getUint32(dsdb + 4);
  const recordCount = view.getUint32(dsdb + 8);
  const nodes = view.getUint32(dsdb + 12);
  expect(view.getUint32(dsdb + 16)).toBe(0x1000);
  const records: DsStoreRecord[] = [];
  const utf16 = (start: number, units: number) =>
    String.fromCharCode(...Array.from({ length: units }, (_, index) => view.getUint16(start + index * 2)));
  let visitedNodes = 0;
  const readRecord = (start: number): number => {
    let cursor = start;
    const nameLength = view.getUint32(cursor);
    const name = utf16(cursor + 4, nameLength);
    cursor += 4 + nameLength * 2;
    const code = Buffer.from(bytes.subarray(cursor, cursor + 4)).toString("latin1");
    const type = Buffer.from(bytes.subarray(cursor + 4, cursor + 8)).toString("latin1") as DsStoreRecord["type"];
    cursor += 8;
    if (type === "long" || type === "shor") {
      records.push({ name, code, type, value: view.getUint32(cursor) });
      return cursor + 4;
    }
    if (type === "bool") {
      records.push({ name, code, type, value: bytes[cursor] === 1 });
      return cursor + 1;
    }
    if (type === "type") {
      records.push({ name, code, type, value: Buffer.from(bytes.subarray(cursor, cursor + 4)).toString("latin1") });
      return cursor + 4;
    }
    if (type === "blob") {
      const length = view.getUint32(cursor);
      records.push({ name, code, type, value: bytes.slice(cursor + 4, cursor + 4 + length) });
      return cursor + 4 + length;
    }
    if (type === "ustr") {
      const length = view.getUint32(cursor);
      records.push({ name, code, type, value: utf16(cursor + 4, length) });
      return cursor + 4 + length * 2;
    }
    throw new Error(`unexpected record type ${type}`);
  };
  const readNode = (id: number, depth: number) => {
    visitedNodes += 1;
    let cursor = blockOffset(id);
    const rightmost = view.getUint32(cursor);
    const entries = view.getUint32(cursor + 4);
    expect(rightmost === 0).toBe(depth === levels);
    cursor += 8;
    for (let index = 0; index < entries; index += 1) {
      if (rightmost !== 0) {
        readNode(view.getUint32(cursor), depth + 1);
        cursor += 4;
      }
      cursor = readRecord(cursor);
    }
    expect(cursor).toBeLessThanOrEqual(blockEnd(id));
    if (rightmost !== 0) readNode(rightmost, depth + 1);
  };
  readNode(rootNode, 0);
  expect(records).toHaveLength(recordCount);
  expect(visitedNodes).toBe(nodes);
  return { records, blocks, free, levels, nodes };
}

function plutilXml(bytes: Uint8Array): unknown {
  const root = mkdtempSync(join(tmpdir(), "butler-bplist-"));
  roots.push(root);
  const path = join(root, "value.plist");
  writeFileSync(path, bytes);
  const lint = spawnSync("plutil", ["-lint", path], { encoding: "utf8" });
  expect(lint.stdout).toContain("OK");
  const xml = spawnSync("plutil", ["-convert", "xml1", "-o", "-", path], { encoding: "utf8" });
  expect(xml.status).toBe(0);
  return xml.stdout;
}

test("binary plist encoder writes a bplist00 document with typed values", () => {
  const bytes = encodeBinaryPlist({
    ShowToolbar: false,
    SidebarWidth: 0,
    WindowBounds: "{{200, 120}, {660, 428}}",
    iconSize: plistReal(128),
    alias: new Uint8Array([1, 2, 3]),
    list: ["a", 1],
  });
  expect(Buffer.from(bytes.subarray(0, 8)).toString("latin1")).toBe("bplist00");
  const trailer = new DataView(bytes.buffer, bytes.byteOffset + bytes.byteLength - 32, 32);
  expect(trailer.getUint8(6)).toBeGreaterThan(0);
  expect(trailer.getUint8(7)).toBe(1);
  expect(Number(trailer.getBigUint64(8))).toBe(15);
  expect(Number(trailer.getBigUint64(16))).toBe(0);
});

test.if(process.platform === "darwin")("binary plist output round-trips through plutil", () => {
  const xml = plutilXml(encodeBinaryPlist({
    ShowToolbar: false,
    labelOnBottom: true,
    SidebarWidth: 0,
    viewOptionsVersion: 1,
    WindowBounds: "{{200, 120}, {660, 428}}",
    iconSize: plistReal(128),
    textSize: plistReal(12.5),
    arrangeBy: "none",
    title: "Butler — é",
    alias: new Uint8Array(Array.from({ length: 300 }, (_, index) => index % 256)),
  })) as string;
  expect(xml).toContain("<key>ShowToolbar</key>\n\t<false/>");
  expect(xml).toContain("<key>labelOnBottom</key>\n\t<true/>");
  expect(xml).toContain("<key>SidebarWidth</key>\n\t<integer>0</integer>");
  expect(xml).toContain("<key>iconSize</key>\n\t<real>128</real>");
  expect(xml).toContain("<key>textSize</key>\n\t<real>12.5</real>");
  expect(xml).toContain("<string>{{200, 120}, {660, 428}}</string>");
  expect(xml).toContain("<string>Butler — é</string>");
  expect(xml).toContain("<key>alias</key>\n\t<data>");
});

test(".DS_Store encoder writes a Finder buddy-allocator file with sorted records", () => {
  const input: DsStoreRecord[] = [
    { name: "Butler.app", code: "Iloc", type: "blob", value: new Uint8Array(16) },
    { name: ".", code: "vSrn", type: "long", value: 1 },
    { name: "Applications", code: "Iloc", type: "blob", value: new Uint8Array(16) },
    { name: ".", code: "icvl", type: "type", value: "icnv" },
    { name: ".", code: "bwsp", type: "blob", value: new Uint8Array([7, 8]) },
  ];
  const bytes = encodeDsStore(input);
  const parsed = readDsStore(bytes);
  expect(parsed.records.map((record) => `${record.name}:${record.code}`)).toEqual([
    ".:bwsp",
    ".:icvl",
    ".:vSrn",
    "Applications:Iloc",
    "Butler.app:Iloc",
  ]);
  expect(parsed.records[1]).toEqual({ name: ".", code: "icvl", type: "type", value: "icnv" });
  expect(parsed.records[0]!.value).toEqual(new Uint8Array([7, 8]));
  expect(parsed.levels).toBe(0);
  expect(parsed.nodes).toBe(1);
  expect(parsed.blocks).toEqual([0x200b, 0x45, 0x100c]);
  expect(parsed.free[5]).toEqual([0x20, 0x60]);
  expect(parsed.free[11]).toEqual([0x800, 0x2800]);
  expect(parsed.free[13]).toEqual([]);
  expect(parsed.free[30]).toEqual([0x40000000]);
  expect(parsed.free[31]).toEqual([]);
});

test(".DS_Store encoder spills large records into a two-level B-tree", () => {
  const input: DsStoreRecord[] = [
    { name: ".", code: "bwsp", type: "blob", value: new Uint8Array(900).fill(1) },
    { name: ".", code: "icvp", type: "blob", value: new Uint8Array(1500).fill(2) },
    { name: ".", code: "pBBk", type: "blob", value: new Uint8Array(2300).fill(3) },
    { name: ".", code: "vSrn", type: "long", value: 1 },
    { name: "Applications", code: "Iloc", type: "blob", value: new Uint8Array(16).fill(4) },
    { name: "Butler.app", code: "Iloc", type: "blob", value: new Uint8Array(16).fill(5) },
  ];
  const parsed = readDsStore(encodeDsStore(input));
  expect(parsed.levels).toBe(1);
  expect(parsed.nodes).toBeGreaterThan(2);
  expect(parsed.records).toEqual(input);
  for (const address of parsed.blocks) {
    const size = 2 ** (address & 0x1f);
    expect((address & ~0x1f) % size).toBe(0);
  }
});

test(".DS_Store encoder refuses a record larger than one B-tree page", () => {
  expect(() => encodeDsStore([
    { name: ".", code: "pBBk", type: "blob", value: new Uint8Array(5000) },
  ])).toThrow("DMG .DS_Store record .:pBBk does not fit in one 4096-byte B-tree node");
});

test("DMG layout positions Butler and Applications over the branded background", () => {
  const alias = new Uint8Array([0xaa, 0xbb, 0xcc]);
  const bookmark = new Uint8Array([0x62, 0x6f, 0x6f, 0x6b]);
  const records = dmgLayoutRecords({ appName: "Butler.app", backgroundAlias: alias, backgroundBookmark: bookmark });
  const byKey = new Map(records.map((record) => [`${record.name}:${record.code}`, record]));
  expect([...byKey.keys()].sort()).toEqual([
    ".:bwsp",
    ".:icvl",
    ".:icvp",
    ".:pBBk",
    ".:vSrn",
    ".:vstl",
    "Applications:Iloc",
    "Butler.app:Iloc",
  ]);
  const iloc = (name: string) => {
    const value = byKey.get(`${name}:Iloc`)!.value as Uint8Array;
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    return { x: view.getUint32(0), y: view.getUint32(4), length: value.byteLength };
  };
  expect(iloc("Butler.app")).toEqual({ ...DMG_LAYOUT.appPosition, length: 16 });
  expect(iloc("Applications")).toEqual({ ...DMG_LAYOUT.applicationsPosition, length: 16 });
  expect(byKey.get(".:pBBk")!.value).toEqual(bookmark);
  expect(byKey.get(".:vstl")!.value).toBe("icnv");
  const icvp = Buffer.from(byKey.get(".:icvp")!.value as Uint8Array);
  expect(icvp.subarray(0, 8).toString("latin1")).toBe("bplist00");
  expect(icvp.includes(Buffer.from(alias))).toBe(true);
  expect(icvp.includes(Buffer.from("backgroundImageAlias"))).toBe(true);
  const bwsp = Buffer.from(byKey.get(".:bwsp")!.value as Uint8Array);
  const { x, y } = DMG_LAYOUT.windowOrigin;
  const { width, height } = DMG_LAYOUT.contentSize;
  expect(bwsp.includes(Buffer.from(`{{${x}, ${y}}, {${width}, ${height + DMG_LAYOUT.titleBarHeight}}}`))).toBe(true);
  expect(() => encodeDsStore(records)).not.toThrow();
});

test.if(process.platform === "darwin")("DMG layout view options decode as Finder icon view settings", () => {
  const records = dmgLayoutRecords({
    appName: "Butler.app",
    backgroundAlias: new Uint8Array([1, 2, 3]),
    backgroundBookmark: new Uint8Array([4]),
  });
  const icvp = plutilXml(records.find((record) => record.code === "icvp")!.value as Uint8Array) as string;
  expect(icvp).toContain("<key>backgroundType</key>\n\t<integer>2</integer>");
  expect(icvp).toContain(`<key>iconSize</key>\n\t<real>${DMG_LAYOUT.iconSize}</real>`);
  expect(icvp).toContain("<key>arrangeBy</key>\n\t<string>none</string>");
  const bwsp = plutilXml(records.find((record) => record.code === "bwsp")!.value as Uint8Array) as string;
  expect(bwsp).toContain("<key>ShowToolbar</key>\n\t<false/>");
  expect(bwsp).toContain("<key>ShowSidebar</key>\n\t<false/>");
});
