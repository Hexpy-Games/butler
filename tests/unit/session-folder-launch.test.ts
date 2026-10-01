import { describe, expect, test } from "bun:test";
import {
  buildSessionFolderLaunchSpec,
  createSessionFolderLauncher,
} from "../../packages/butler-app/client/electron/session-folder-launch.mjs";

const windowsFolder = String.raw`C:\Users\yeonw\Work Area\프로젝트 세션`;
const linuxFolder = "/home/yeonw/Work Area/프로젝트 세션";

function commandResolver(commands: Record<string, string>) {
  return (command: string) => commands[command] ?? null;
}

describe("session folder launch command construction", () => {
  // test-category: pure-logic
  test("constructs Windows Explorer, Terminal, and VS Code launches without flattening paths", () => {
    const commands = commandResolver({
      "explorer.exe": String.raw`C:\Windows\explorer.exe`,
      "wt.exe": String.raw`C:\Program Files\Windows Terminal\wt.exe`,
      "code.cmd": String.raw`C:\Users\yeonw\AppData\Programs\VS Code\bin\code.cmd`,
      "cmd.exe": String.raw`C:\Windows\System32\cmd.exe`,
    });

    expect(buildSessionFolderLaunchSpec("win32", "fileManager", windowsFolder, commands)).toEqual({
      command: String.raw`C:\Windows\explorer.exe`,
      args: [windowsFolder],
    });
    expect(buildSessionFolderLaunchSpec("win32", "terminal", windowsFolder, commands)).toEqual({
      command: String.raw`C:\Program Files\Windows Terminal\wt.exe`,
      args: ["-d", windowsFolder],
    });
    expect(buildSessionFolderLaunchSpec("win32", "vscode", windowsFolder, commands)).toEqual({
      command: String.raw`C:\Windows\System32\cmd.exe`,
      args: [
        "/d",
        "/s",
        "/c",
        "call",
        String.raw`C:\Users\yeonw\AppData\Programs\VS Code\bin\code.cmd`,
        windowsFolder,
      ],
    });
  });

  // test-category: pure-logic
  test("uses the Windows Command Prompt terminal fallback when Windows Terminal is missing", () => {
    const commands = commandResolver({ "cmd.exe": String.raw`C:\Windows\System32\cmd.exe` });

    expect(buildSessionFolderLaunchSpec("win32", "terminal", windowsFolder, commands)).toEqual({
      command: String.raw`C:\Windows\System32\cmd.exe`,
      args: ["/c", "start", "", "/D", windowsFolder, "cmd.exe"],
    });
  });

  // test-category: pure-logic
  test("constructs Linux file manager, terminal fallbacks, and VS Code launches", () => {
    expect(buildSessionFolderLaunchSpec(
      "linux",
      "fileManager",
      linuxFolder,
      commandResolver({ "xdg-open": "/usr/bin/xdg-open" }),
    )).toEqual({ command: "/usr/bin/xdg-open", args: [linuxFolder] });

    expect(buildSessionFolderLaunchSpec(
      "linux",
      "terminal",
      linuxFolder,
      commandResolver({ "x-terminal-emulator": "/usr/bin/x-terminal-emulator" }),
    )).toEqual({
      command: "/usr/bin/x-terminal-emulator",
      args: [],
      options: { cwd: linuxFolder },
    });
    expect(buildSessionFolderLaunchSpec(
      "linux",
      "terminal",
      linuxFolder,
      commandResolver({ "gnome-terminal": "/usr/bin/gnome-terminal" }),
    )).toEqual({
      command: "/usr/bin/gnome-terminal",
      args: ["--working-directory", linuxFolder],
    });
    expect(buildSessionFolderLaunchSpec(
      "linux",
      "terminal",
      linuxFolder,
      commandResolver({ konsole: "/usr/bin/konsole" }),
    )).toEqual({
      command: "/usr/bin/konsole",
      args: ["--workdir", linuxFolder],
    });
    expect(buildSessionFolderLaunchSpec(
      "linux",
      "vscode",
      linuxFolder,
      commandResolver({ code: "/usr/bin/code" }),
    )).toEqual({ command: "/usr/bin/code", args: [linuxFolder] });
  });

  // test-category: pure-logic
  test("keeps the existing macOS Terminal and VS Code command construction", () => {
    expect(buildSessionFolderLaunchSpec("darwin", "terminal", linuxFolder)).toEqual({
      application: "Terminal",
      command: "open",
      args: ["-a", "Terminal", linuxFolder],
    });
    expect(buildSessionFolderLaunchSpec("darwin", "vscode", linuxFolder)).toEqual({
      application: "Visual Studio Code",
      command: "open",
      args: ["-a", "Visual Studio Code", linuxFolder],
    });
  });

  // test-category: pure-logic
  test("returns an unavailable target result when no Linux launcher is on PATH", async () => {
    const launcher = createSessionFolderLauncher({
      platform: "linux",
      resolveWorkspacePath: () => linuxFolder,
      isDirectory: () => true,
      resolveCommand: () => null,
    });

    expect(await launcher.availableTargets("session-1")).toEqual({ ok: true, targets: [] });
    expect(await launcher.openSessionFolder({
      sessionId: "session-1",
      target: "fileManager",
    })).toEqual({
      ok: false,
      code: "launch_target_unavailable",
      recoverable: true,
    });
  });
});
