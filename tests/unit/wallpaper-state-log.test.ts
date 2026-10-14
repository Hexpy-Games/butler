// test-category: security
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWallpaperStateLog, WALLPAPER_STATE_SESSION_CAP } from "../../packages/butler-app/client/electron/wallpaper-state-log.mjs";
import { wallpaperStateLine } from "../../packages/butler-app/client/ui/src/app/wallpaperStateLine";

test("wallpaper state lines carry enum fields only and the setup step when it is a plain id", () => {
  expect(wallpaperStateLine({ signal: "visibility", value: "hidden", mode: "idle", reason: "hidden" }, "import"))
    .toBe("wallpaper_state visibility=hidden mode=idle reason=hidden step=import");
  expect(wallpaperStateLine({ signal: "mode", value: "static", mode: "static", reason: "constrained" }, null))
    .toBe("wallpaper_state mode=static reason=constrained");
  expect(wallpaperStateLine({ signal: "context", value: "lost", mode: "idle", reason: "context-lost" }, "a b"))
    .toBe("wallpaper_state context=lost mode=idle reason=context-lost");
});

test("the main log keeps only well-formed lines, caps a session and writes under app/logs", async () => {
  const root = mkdtempSync(join(tmpdir(), "wallpaper-state-"));
  try {
    const echoed: string[] = [];
    const log = createWallpaperStateLog(root, { now: () => new Date(0), echo: (line: string) => echoed.push(line) });
    expect(log.record("wallpaper_state visibility=hidden mode=idle reason=hidden step=import")).toBe(true);
    for (const bad of ["token=abc", "wallpaper_state note=Hello World", "wallpaper_state x=" + "a".repeat(40), 7]) expect(log.record(bad)).toBe(false);
    for (let index = 1; index < WALLPAPER_STATE_SESSION_CAP + 10; index += 1) log.record("wallpaper_state mode=drift reason=none");
    await log.flushed();
    const lines = readFileSync(join(root, "app", "logs", "wallpaper-state.log"), "utf8").trimEnd().split("\n");
    expect(lines.length).toBe(WALLPAPER_STATE_SESSION_CAP);
    expect(lines[0]).toBe("1970-01-01T00:00:00.000Z wallpaper_state visibility=hidden mode=idle reason=hidden step=import");
    expect(echoed.length).toBe(WALLPAPER_STATE_SESSION_CAP);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
