import { expect, test } from "bun:test";
import {
  APP_AGENT_CANDIDATE_BOOT_TOKEN_FIELDS,
  APP_AGENT_SERVICE_STATUSES,
  APP_AGENT_UPDATE_STATUSES,
  APP_BACKGROUND_SERVICE_CAPABILITIES,
  APP_BACKGROUND_SERVICE_RUNTIME_FIELDS,
  APP_AGENT_UPDATE_TRANSACTION_FIELDS,
  appBackgroundServiceCapability,
  isAppAgentServiceStatus,
  isAppAgentUpdateStatus,
} from "../../packages/butler-app/scripts/background-service-contract.ts";

function expectNoDuplicates(values: readonly string[]) {
  expect(new Set(values).size).toBe(values.length);
}

test("App background service status vocabulary is shared and stable", () => {
  expectNoDuplicates(APP_AGENT_SERVICE_STATUSES);
  expect(APP_AGENT_SERVICE_STATUSES).toEqual([
    "not_installed",
    "installing",
    "starting",
    "ready",
    "stopped",
    "failed",
    "needs_permission",
    "draining",
    "updating",
    "restarting",
    "rollback",
  ]);
  expect(isAppAgentServiceStatus("ready")).toBe(true);
  expect(isAppAgentServiceStatus("unknown")).toBe(false);
});

test("App background update status vocabulary covers staged restart and rollback", () => {
  expectNoDuplicates(APP_AGENT_UPDATE_STATUSES);
  expect(APP_AGENT_UPDATE_STATUSES).toEqual([
    "idle",
    "update_available",
    "staging",
    "draining",
    "restart_required",
    "restarting",
    "candidate_ready",
    "promoting",
    "ready",
    "rollback",
    "failed",
  ]);
  expect(isAppAgentUpdateStatus("candidate_ready")).toBe(true);
  expect(isAppAgentUpdateStatus("not_installed")).toBe(false);
});

test("App-managed service runtime fields are explicit before service implementation", () => {
  expectNoDuplicates(APP_BACKGROUND_SERVICE_RUNTIME_FIELDS);
  expect(APP_BACKGROUND_SERVICE_RUNTIME_FIELDS).toEqual([
    "BUTLER_HOME",
    "BUTLER_DATA",
    "BUTLER_BUN",
    "BUTLER_APP_MANAGED_RUNTIME_POINTER",
    "BUTLER_APP_MANAGED_RUNTIME_HOME",
    "BUTLER_APP_SERVER_HOST",
    "BUTLER_APP_SERVER_PORT",
    "BUTLER_APP_GATEWAY_PID_FILE",
    "BUTLER_APP_LOCAL_AUTH_REQUIRED",
    "BUTLER_APP_LOCAL_AUTH_FILE",
  ]);
});

test("Agent runtime update transaction fields include active candidate and proof data", () => {
  expectNoDuplicates(APP_AGENT_UPDATE_TRANSACTION_FIELDS);
  expect(APP_AGENT_UPDATE_TRANSACTION_FIELDS).toEqual([
    "schema",
    "generation",
    "status",
    "previous_active_pointer",
    "active_pointer",
    "candidate_pointer",
    "candidate_digest",
    "candidate_boot_token_hash",
    "readiness_proof",
    "started_at",
    "updated_at",
    "last_error",
  ]);
  expect(APP_AGENT_CANDIDATE_BOOT_TOKEN_FIELDS).toEqual([
    "generation",
    "candidate_pointer",
    "candidate_digest",
    "token",
  ]);
});

test("Phase 0 platform capability matrix gates implementation by platform", () => {
  expect(APP_BACKGROUND_SERVICE_CAPABILITIES.map((item) => item.platform).sort()).toEqual([
    "darwin",
    "linux",
    "win32",
  ]);
  expect(APP_BACKGROUND_SERVICE_CAPABILITIES.every((item) => item.implementationStartsAfterPhase0))
    .toBe(true);

  const macos = appBackgroundServiceCapability("darwin");
  expect(macos.requiredDecision).toBe("macos-registration-path");
  expect(macos.blocksBeforePhase).toBe("phase-2-service-control");
  expect(macos.selectedV1Path).toBeNull();
  expect(macos.allowedV1Paths).toEqual([
    "macos-pkg-launch-agent",
    "macos-first-run-launch-agent",
    "macos-smappservice-helper",
  ]);
  expect(macos.allowedMechanisms).toContain("smappservice-helper");

  const linux = appBackgroundServiceCapability("linux");
  expect(linux.requiredDecision).toBe("linux-package-service-path");
  expect(linux.primaryMechanism).toContain("systemd --user");
  expect(linux.allowedV1Paths).toEqual([
    "linux-systemd-user-service",
    "linux-deb-owned-user-unit",
    "linux-rpm-owned-user-unit",
  ]);
  expect(linux.allowedMechanisms).toContain("deb-owned-user-unit");

  const windows = appBackgroundServiceCapability("win32");
  expect(windows.requiredDecision).toBe("windows-user-security-context");
  expect(windows.installerRequired).toBe("yes");
  expect(windows.allowedV1Paths).toEqual([
    "windows-per-user-agent-at-sign-in",
    "windows-least-privilege-user-service",
    "windows-split-elevated-helper",
  ]);
  expect(windows.userContext).toContain("must not default to LocalSystem");
  expect(windows.allowedMechanisms).toContain("split-elevated-helper");
});

test("unsupported App background service platforms fail closed", () => {
  expect(() => appBackgroundServiceCapability("freebsd" as never)).toThrow(
    "unsupported App background service platform",
  );
});
