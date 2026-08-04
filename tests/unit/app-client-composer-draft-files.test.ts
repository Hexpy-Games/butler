import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composerDraftFilePath,
  readComposerDraftFile,
  writeComposerDraftFile,
} from "../../packages/butler-app/client/electron/composer-draft-cache.mjs";

test("Electron draft cache persists isolated session files with hashed names", () => {
  const directory = mkdtempSync(join(tmpdir(), "butler-composer-drafts-"));
  try {
    expect(writeComposerDraftFile(directory, {
      schema: "butler.composer-draft.v1",
      session_id: "session/private-a",
      text: "alpha",
      updated_at: "2026-08-04T01:00:00.000Z",
    })).toEqual({ ok: true });
    expect(writeComposerDraftFile(directory, {
      schema: "butler.composer-draft.v1",
      session_id: "session-b",
      text: "beta",
      updated_at: "2026-08-04T01:00:01.000Z",
    })).toEqual({ ok: true });

    expect(readComposerDraftFile(directory, "session/private-a")?.text).toBe("alpha");
    expect(readComposerDraftFile(directory, "session-b")?.text).toBe("beta");
    expect(readdirSync(directory)).toHaveLength(2);
    expect(readdirSync(directory).join(" ")).not.toContain("private-a");
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(
      statSync(composerDraftFilePath(directory, "session/private-a")).mode &
        0o777,
    ).toBe(0o600);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Electron draft cache keeps an empty tombstone and ignores corrupt data", () => {
  const directory = mkdtempSync(join(tmpdir(), "butler-composer-drafts-"));
  try {
    writeComposerDraftFile(directory, {
      schema: "butler.composer-draft.v1",
      session_id: "session-a",
      text: "before clear",
      updated_at: "2026-08-04T01:00:00.000Z",
    });
    writeComposerDraftFile(directory, {
      schema: "butler.composer-draft.v1",
      session_id: "session-a",
      text: "",
      updated_at: "2026-08-04T01:00:01.000Z",
    });
    expect(readComposerDraftFile(directory, "session-a")?.text).toBe("");

    writeFileSync(composerDraftFilePath(directory, "session-a"), "not-json");
    expect(readComposerDraftFile(directory, "session-a")).toBeNull();
    expect(readFileSync(composerDraftFilePath(directory, "session-a"), "utf8"))
      .toBe("not-json");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
