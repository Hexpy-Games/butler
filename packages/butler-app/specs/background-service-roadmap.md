# Butler App Background Service Roadmap

## Status

Ready for implementation planning. This roadmap breaks the background service
distribution work into reviewable phases.

## Phase 0: Baseline And Contracts

Goal: freeze the target process/service/update contracts before behavior moves.

Tasks:

1. Add App background service specs.
2. Add test guard proving production App first-run no longer depends on
   Electron child supervisor semantics once migration starts.
3. Add `packages/butler-app/scripts/background-service-contract.ts` with the
   service status vocabulary shared by first-run, tray, and updater.
4. Identify the App-managed runtime pointer fields required by the service
   supervisor.
5. Add platform registration capability matrix:
   - macOS LaunchAgent versus SMAppService versus `.pkg`
   - Windows per-user agent versus Windows Service versus split helper
   - Linux `systemd --user` versus package-owned units
6. Decide the v1 installer/registration path before first-run service UI work
   starts.

Acceptance:

- Specs exist for background service distribution and update/restart behavior.
- The task backlog maps every implementation phase to tests.
- `background-service-contract.ts` exports Phase 0 service statuses, update
  statuses, runtime fields, transaction fields, platform capabilities, and
  structured unresolved v1 registration decisions.
- Platform registration and installer constraints are fixed before service
  bridge/UI implementation starts.
- No runtime behavior changes are included in this phase.

Validation:

- `git diff --check`
- `bun test tests/unit/app-background-service-contract.test.ts`

## Phase 1: App-Managed Service Runtime Contract

Goal: make the Agent service supervisor able to run from an App-managed runtime
instead of only a standalone source/install home.

Tasks:

1. Add an App-managed service path resolver:
   - active runtime pointer
   - runtime home
   - bundled Bun path
   - app gateway port
   - local auth file
2. Extend native service specs so `appManagedNativeServiceSpecs` can emit
   App-managed specs.
3. Ensure app gateway is included and service-owned for App distribution.
4. Preserve standalone Agent specs unchanged.
5. Add process group stop/restart tests for App-managed specs.
6. Add bounded stop primitives required by updates:
   - wait for process group exit
   - verify child pid death
   - verify app gateway port release
   - escalate to kill after timeout

Primary files:

- `packages/butler-app/scripts/background-service-contract.ts`
- `packages/butler-agent/src/operations/service/native-service-supervisor.ts`
- `packages/butler-app/client/electron/app-managed-runtime.mjs`
- `tests/unit/native-service-supervisor.test.ts`
- `tests/unit/app-managed-runtime.test.ts`

Acceptance:

- App-managed service specs point to the active runtime home.
- Standalone service specs still point to standalone Butler home.
- App-managed app gateway uses `gateway_profile=electron` and local auth.
- Process group state records expose runtime version and pointer path.
- App-managed stop/restart contracts can prove the previous process group has
  released pids and ports before a new runtime starts.

Implemented surface:

- `appManagedNativeServiceSpecs` resolves the active App-managed runtime pointer
  into native service specs.
- `resolveAppManagedNativeSupervisorPaths` fails closed on damaged or
  non-`electron` runtime pointers.
- `stopServiceBounded` is the update-facing stop primitive. It waits for pid
  exit, escalates to `SIGKILL`, verifies app gateway port release, and preserves
  service state if stop cannot be proven.

Validation:

- `bun test tests/unit/native-service-supervisor.test.ts tests/unit/app-background-service-contract.test.ts`

## Phase 2: OS Service Registration For App Distribution

Goal: first-run can install or verify a background Agent service.

Tasks:

1. Add Electron main service-control module.
2. Add IPC bridge:
   - status
   - install
   - start
   - stop
   - restart
   - diagnostics
3. Reuse launchd/systemd adapter where possible.
4. Add Windows service adapter plan and tests only after the Phase 0
   user/security-context decision.
5. Add service installation diagnostics with redacted paths/secrets.

Primary files:

- `packages/butler-app/scripts/background-service-contract.ts`
- `packages/butler-app/client/electron/service-control.mjs`
- `packages/butler-app/client/electron/*service*.mjs`
- `packages/butler-app/client/electron/preload.cjs`
- `packages/butler-agent/src/operations/service/os-service-adapter.ts`
- `tests/unit/app-agent-service-control.test.ts`
- `tests/unit/app-first-run-setup-bridge*.test.ts`
- `tests/unit/os-service-adapter.test.ts`

Acceptance:

- App first-run can distinguish `not_installed`, `installing`, `starting`,
  `ready`, `failed`, and `needs_permission`.
- Failed service registration does not fall back to Electron child gateway
  silently.
- Windows has an explicit installer-required path instead of pretending
  launchd/systemd applies.

Implemented surface:

- `service-control.mjs` exposes a narrow Electron-main-owned Agent service
  control API for status/install/start/stop/restart/diagnostics.
- `main.mjs` and `preload.cjs` expose the service-control IPC surface without
  shelling out from renderer code.
- Until platform adapters land, service actions fail closed with
  `service_registration_unavailable` and return redacted diagnostics.

Validation:

- `bun test tests/unit/app-agent-service-control.test.ts tests/unit/app-first-run-setup-bridge.test.ts`

## Phase 3: First-Run Service Setup UI

Goal: replace the current "Electron-managed bundled Agent readiness" behavior
with "background Agent service setup".

Tasks:

1. Update first-run copy:
   - `Butler Agent를 준비합니다`
   - service setup status
   - permission/retry/diagnostics actions
2. Keep language, safety, install, model order.
3. Keep model setup after service readiness.
4. Keep OAuth and local model setup behavior from the existing settings modules.
5. Add smoke coverage proving first-run reaches workspace only after
   service-owned app gateway readiness.

Primary files:

- `packages/butler-app/client/ui/src/components/first-run/*`
- `packages/butler-app/specs/first-run-setup.md`
- `tests/smoke/app-first-run-setup-smoke.ts`

Acceptance:

- The setup bridge uses service-control before managed gateway readiness.
- The install step fails closed before managed gateway readiness when service
  registration or startup fails.
- Service-owned app gateway readiness replaces the current managed readiness
  implementation when platform adapters land.
- The UI does not expose terminal dependency prompts.
- The UI does not offer an existing-Agent connection path in App distribution.
- Diagnostics are redacted and actionable.

Implemented surface:

- `createFirstRunSetupBridge` checks service-control before managed gateway
  readiness and fails closed when service registration is unavailable.
- Startup failure and post-start not-ready service states stay in the install
  step and do not call managed gateway readiness.
- Existing first-run UI copy and retry/diagnostics controls are reused for the
  service setup failure path.

Validation:

- `bun test tests/unit/app-first-run-setup-bridge.test.ts tests/unit/app-first-run-setup-bridge-runtime.test.ts packages/butler-app/client/ui/src/components/first-run/FirstRunSetup.test.tsx tests/unit/app-first-run-setup.test.ts`

## Phase 4: Tray/Menu Bar Service Controller

Goal: make the tray/menu bar represent background service state.

Tasks:

1. Add service status polling/subscription in Electron main.
2. Add tray states:
   - running
   - starting
   - stopped
   - updating
   - failed
3. Add tray actions:
   - Open Butler
   - Restart Butler Agent
   - Stop Butler Agent
   - Start Butler Agent
   - Quit Butler UI
4. Ensure Quit UI does not stop the service by default.
5. Add tests around `before-quit`, tray action handlers, and service calls.

Primary files:

- `packages/butler-app/client/electron/main.mjs`
- `tests/unit/app-client-design.test.ts`
- new Electron service controller tests

Acceptance:

- Closing the window leaves service online.
- Quitting UI leaves service online.
- Explicit Stop Agent stops the service process group.
- Tray state reflects diagnostics after failure.

## Phase 5: App Update, Restart, And Rollback

Goal: Agent runtime updates restart the service group safely.

Tasks:

1. Add update state model and persisted update status.
2. Add active/candidate runtime pointer transaction files.
3. Stage new bundled Agent runtime without mutating active pointer.
4. Add service drain/restart path using bounded stop primitives.
5. Boot the candidate runtime without promoting it to active.
6. Verify readiness before promotion.
7. Promote candidate pointer to active only after readiness succeeds.
8. Roll back transaction and restart previous service on failure.
9. Add UI/tray update status copy.

Primary files:

- `packages/butler-app/scripts/background-service-contract.ts`
- `packages/butler-app/client/electron/app-managed-runtime.mjs`
- `packages/butler-agent/src/operations/update/component-updater.ts`
- new App updater bridge module
- `tests/unit/app-managed-runtime.test.ts`
- `tests/unit/release-packaging.test.ts`

Acceptance:

- Agent runtime update restarts the whole service group once.
- UI-only update does not restart service unless protocol requires it.
- A crash before candidate readiness never makes the candidate active.
- Rollback restores previous runtime and reports status.

## Phase 6: Installer And Release Packaging

Goal: release artifacts can install and operate the background service.

Tasks:

1. macOS:
   - implement the Phase 0 `.pkg` versus first-run LaunchAgent decision
   - include service/helper payload in signed/notarized artifact
2. Windows:
   - implement the Phase 0 Windows user/security-context decision
3. Linux:
   - add `.deb`/`.rpm` service unit packaging path
4. Update app release manifest:
   - service capability
   - bundled Agent service runtime metadata
   - installer requirements
5. Update release workflow and smoke tests.

Primary files:

- `packages/butler-app/scripts/release/*`
- `.github/workflows/release.yml`
- `tests/unit/release-packaging.test.ts`
- `tests/unit/release-workflow.test.ts`

Acceptance:

- App release artifacts declare service installation capability.
- Installer smoke verifies service registration artifacts.
- App release still bundles Agent runtime and dependency closure.

## Phase 7: End-To-End Verification

Goal: prove the product behavior users will rely on.

Tasks:

1. E2E: first-run installs service and reaches workspace.
2. E2E: close window, service remains online.
3. E2E: quit UI, service remains online.
4. E2E: Stop Agent terminates process group.
5. E2E: update Agent runtime restarts process group.
6. E2E: failed update rolls back.

Acceptance:

- No production App path relies on an Electron-owned Agent child process.
- Background consolidation can continue while the UI is closed.
- Service diagnostics are available when the UI is reopened.

## Initial Implementation Order

1. Phase 0 baseline contracts and platform registration decision gate.
2. Phase 1 App-managed service specs.
3. Phase 2 service-control bridge.
4. Phase 3 first-run service setup.
5. Phase 4 tray/menu controller.
6. Phase 5 update/restart/rollback.
7. Phase 6 installer packaging.
8. Phase 7 cross-platform E2E.

This order keeps the runtime contract stable before UI and installer work start.
