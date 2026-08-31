import { expect, test } from "bun:test";
import {
  createSessionFolderLauncher,
} from "../../packages/butler-app/client/electron/session-folder-launch.mjs";
import { handleInternalSessionWorkspaceRoutes } from
  "../../packages/butler-agent/src/gateways/app/interface/server/routes/internal-session-workspace-routes.ts";
import type { AppRouteContext } from
  "../../packages/butler-agent/src/gateways/app/interface/server/server-types.ts";

const sessionId = "session-folder-test";
const workspacePath = "/private/session-folder-workspace";

function launcher(overrides: Record<string, unknown> = {}) {
  return createSessionFolderLauncher({
    platform: "darwin",
    resolveWorkspacePath: async (requestedSessionId: string) => {
      expect(requestedSessionId).toBe(sessionId);
      return workspacePath;
    },
    isDirectory: async (requestedPath: string) => requestedPath === workspacePath,
    isApplicationAvailable: () => true,
    ...overrides,
  });
}

test("available session-folder targets use the canonical session resolver", async () => {
  const result = await launcher().availableTargets(sessionId);

  expect(result).toEqual({
    ok: true,
    targets: ["vscode", "terminal"],
  });
});

test("the internal desktop route reads only the canonical session binding operation", async () => {
  const requestedSessionIds: string[] = [];
  const request = new Request(
    `http://localhost/internal/session-workspace?session_id=${sessionId}`,
  );
  const response = await handleInternalSessionWorkspaceRoutes({
    request,
    url: new URL(request.url),
    store: {
      getSessionWorkspacePath(requestedSessionId: string) {
        requestedSessionIds.push(requestedSessionId);
        return workspacePath;
      },
    },
  } as unknown as AppRouteContext);

  expect(response?.status).toBe(200);
  expect(requestedSessionIds).toEqual([sessionId]);
  const body = await response?.json();
  expect(body?.data).toEqual({
    session_id: sessionId,
    workspace_path: workspacePath,
  });
});

test("missing or non-directory canonical bindings do not expose a path", async () => {
  const folderLauncher = createSessionFolderLauncher({
    platform: "darwin",
    resolveWorkspacePath: async (requestedSessionId: string) => {
      expect(requestedSessionId).toBe(sessionId);
      return workspacePath;
    },
    isDirectory: async () => false,
  });

  const result = await folderLauncher.openSessionFolder({
    sessionId,
    target: "vscode",
  });

  expect(result).toEqual({
    ok: false,
    code: "session_workspace_unavailable",
    recoverable: true,
  });
  expect(JSON.stringify(result)).not.toContain(workspacePath);
});

test("opening a session folder uses a closed target and argument-safe launch", async () => {
  let launch: { command: string; args: string[] } | undefined;
  const folderLauncher = launcher({
    launchApplication: (command: string, args: string[]) => {
      launch = { command, args };
      return { ok: true };
    },
  });

  const result = await folderLauncher.openSessionFolder({
    sessionId,
    target: "vscode",
  });

  expect(result).toEqual({ ok: true, target: "vscode" });
  expect(launch).toEqual({
    command: "open",
    args: ["-a", "Visual Studio Code", workspacePath],
  });
});

test("unknown targets and launch failures remain recoverable and path-free", async () => {
  let launches = 0;
  const folderLauncher = launcher({
    launchApplication: () => {
      launches += 1;
      return { ok: false };
    },
  });

  const unknownTarget = await folderLauncher.openSessionFolder({
    sessionId,
    target: "finder",
  });
  expect(unknownTarget).toEqual({
    ok: false,
    code: "launch_target_unavailable",
    recoverable: true,
  });
  expect(launches).toBe(0);

  const failedLaunch = await folderLauncher.openSessionFolder({
    sessionId,
    target: "terminal",
  });
  expect(failedLaunch).toEqual({
    ok: false,
    code: "session_folder_launch_failed",
    recoverable: true,
  });
  expect(JSON.stringify(failedLaunch)).not.toContain(workspacePath);
});
