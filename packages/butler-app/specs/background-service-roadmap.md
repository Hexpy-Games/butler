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
- `app-agent-service-adapter.mjs` defines the App-side adapter contract for
  native service projections and registration hooks. It fails closed when
  native status cannot be collected and only reports `ready` after required
  native services, including `butler-main` and `app-gateway`, are online.
- `app-agent-native-service-bridge.mjs` provides the packaged-safe Electron
  native service bridge for macOS LaunchAgent and Linux `systemd --user`
  registration. Before registration or start it activates the bundled
  App-managed Agent runtime pointer, prepares App-local auth, writes the
  service definition, and invokes the OS service manager.
- `main.mjs` wires the native bridge through `app-agent-service-adapter.mjs`
  only for packaged macOS/Linux App builds. Development and unsupported
  platforms keep failing closed instead of attempting to register a host
  service from an unpackaged Electron process.
- In packaged native-service mode, first-run gateway readiness verifies the
  service-owned app gateway health/protocol and fails closed instead of falling
  back to an Electron-owned child gateway.
- App-managed runtime activation can be rolled back after a service
  registration failure, restoring the previous active pointer when one exists.
- `main.mjs` and `preload.cjs` expose the service-control IPC surface without
  shelling out from renderer code.
- First-run treats `not_installed`, `stopped`, and `needs_permission` as
  registration states that should attempt install before start, so a clean
  packaged App can create the service file before starting the Agent process
  group.

Remaining:

- Replace shell-command bridge execution with signed installer/helper-backed
  registration where required by final macOS/Linux packaging policy.
- Add packaged smoke tests that exercise actual LaunchAgent and `systemd
  --user` registration on target OS runners.
- Add the Windows service adapter after the Windows user/security-context
  decision.

Validation:

- `bun test tests/unit/app-agent-native-service-bridge.test.ts tests/unit/app-agent-service-adapter.test.ts tests/unit/app-agent-service-control.test.ts tests/unit/app-first-run-setup-bridge.test.ts`

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
- Language selection advances locally without touching `/settings` or
  `butler:ensure-server`; the selected language is persisted with the model
  settings patch after the Agent gateway is ready.
- Native service gateway readiness is retried after service start so launchd or
  systemd can finish spawning the service-owned app gateway before first-run or
  renderer API bootstrap reports failure.
- App-managed native service registration passes isolated embed-server
  environment (`EMBED_SOCKET` below the App `BUTLER_DATA`, ephemeral
  `EMBED_HEALTH_PORT`) so install tests and production App services cannot
  remove or bind the standalone Agent embed socket.
- Native-service watchdog children skip the legacy machine-global singleton
  guard and rely on the native service daemon's per-`BUTLER_DATA` process state,
  so isolated App install tests can run beside an operating standalone Butler
  Agent.
- Manual first-run service testing can force the native service bridge in a
  development Electron launch only when a test-only service namespace,
  non-production port, bundled Agent resource directory, and non-production
  `BUTLER_DATA` are present. The helper refuses production labels/units and
  cleans up the test service by default.
- Manual installer testing can build a test-only macOS `.pkg`, install it via
  the macOS `installer` command into a user-home test target, and launch the
  installed App with an isolated Electron profile, isolated `BUTLER_DATA`,
  non-production gateway port, and test-only service label/unit. This covers
  package installation before first-run without touching `/Applications`,
  `~/Library/Application Support/Butler`, `~/.butler`, or `com.hexpy.butler`.

Validation:

- `bun test tests/unit/app-first-run-setup-bridge.test.ts tests/unit/app-first-run-setup-bridge-runtime.test.ts packages/butler-app/client/ui/src/components/first-run/FirstRunSetup.test.tsx tests/unit/app-first-run-setup.test.ts`

## Phase 3A: App Chrome For Linux Packages

Goal: make packaged Linux App chrome match the integrated App distribution
contract without relying on macOS traffic-light spacing.

Tasks:

1. Keep macOS traffic-light spacing only on macOS.
2. Render Linux and Windows App-owned window controls at the titlebar edge,
   outside normal trailing toolbar flow.
3. Keep the sidebar toggle flush to the left edge when App-owned window
   controls are shown on the right.
4. Use a frameless transparent Linux window so the renderer-owned rounded
   shell frame can define the visible window radius.
5. Verify the packaged Linux `.deb` in Ubuntu before reporting completion.

Acceptance:

- Linux/Windows titlebars do not reserve left traffic-light space.
- Linux/Windows window controls are visually anchored to the top-right edge.
- The renderer shell clips to a rounded outer frame on Linux packaged builds.
- macOS keeps native traffic lights and native rounded window behavior.

Validation:

- `bun test tests/unit/app-client-design.test.ts --test-name-pattern "desktop native shell supports notifications tray and cross-platform titlebar reserves|dedicated client sidebar collapse keeps a normal clickable titlebar toggle|electron shell uses native macOS corners"`
- Packaged Ubuntu ARM64 `.deb` smoke screenshot

## Phase 4: Persistent Menu Bar Helper

Goal: make the App-owned menu bar/tray icon represent background service state
without depending on the lifetime of the main App UI process.

Tasks:

1. Split the desktop status icon owner from the main App UI process:
   - macOS: App-bundled menu bar helper or login item.
   - Linux/Windows: tray helper plan matched to the selected packaging path.
2. Add service status polling/subscription in the helper.
3. Add helper states:
   - running
   - starting
   - stopped
   - updating
   - failed
4. Add helper actions:
   - Open Butler
   - Restart Butler Agent
   - Stop Butler Agent
   - Start Butler Agent
   - Quit Butler UI
   - Quit Menu Bar Helper
5. Ensure Quit UI does not stop the service or terminate the helper by default.
6. Ensure Quit Menu Bar Helper does not stop the service by default.
7. Keep standalone Agent installs headless by default; design any standalone tray
   companion as an explicit opt-in package or command.
8. Add tests around UI quit, helper quit, helper action handlers, service calls,
   and standalone headless install defaults.

Primary files:

- `packages/butler-app/client/electron/main.mjs`
- new App helper entrypoint/package files
- App installer/helper registration resources
- `tests/unit/app-client-design.test.ts`
- new Electron service controller tests

Acceptance:

- Closing the window leaves service online.
- Quitting UI leaves service and helper online.
- Quitting helper removes the icon/helper but leaves service online.
- Explicit Stop Agent stops the service process group.
- Helper state reflects diagnostics after failure.
- macOS packaged App behaves like a persistent desktop product: the Agent process
  and menu bar icon remain after the main UI is quit.
- Standalone Agent install does not show a tray/menu icon unless the operator
  explicitly installs the optional desktop companion.

Implemented surface:

- Current implementation is incomplete for the target contract: the menu bar icon
  is owned by the main Electron process, so it disappears when the App UI quits.
  This phase must replace that behavior with a persistent helper.

Validation:

- `bun test tests/unit/app-agent-tray-menu.test.ts`
- `bun test tests/unit/app-client-design.test.ts -t "desktop native shell|electron shell owns"`
- packaged macOS helper lifecycle smoke: quit UI, verify helper icon and Agent
  service remain online
- standalone Agent install smoke: verify no tray/menu helper is installed by
  default

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

Implemented surface:

- App-managed Agent runtime updates now use a persisted transaction with
  previous active pointer, active pointer, candidate pointer, candidate digest,
  candidate boot token hash, readiness proof, status, and last error.
- The candidate boot token is generation and digest locked, consumed on first
  valid candidate boot, and cannot be replayed after consumption.
- Candidate promotion requires readiness proof and keeps the previous pointer
  attached for rollback/audit.
- Rollback restores the previous active pointer and clears candidate boot.
- Crash recovery reconciles partial writes around candidate readiness,
  promotion, rollback, and active pointer restoration.
- Electron main/preload expose update prepare/apply/rollback through the
  service-control bridge. Renderer code still has no direct shell surface.
- Before platform update adapters land, runtime update actions fail closed with
  `agent_runtime_update_unavailable`.

Remaining:

- Wire prepare/apply/rollback to real platform service adapters.
- Use bounded service drain/restart primitives from the adapter path.
- Add update status UI/tray copy once adapter status events exist.
- Add fake previous/next runtime E2E restart and rollback smoke tests.

Validation:

- `bun test tests/unit/app-managed-runtime.test.ts tests/unit/app-agent-service-control.test.ts tests/unit/app-first-run-setup-bridge.test.ts tests/unit/app-background-service-contract.test.ts`
- `git diff --check`

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

Implemented surface:

- App release manifest, component metadata, artifact metadata, and update
  manifest declare `butler.app-background-service-capability.v1`.
- Bundled App resources include
  `bundled-agent/background-service-capability.json`.
- Bundled App resources include
  `bundled-agent/background-service-registration.json` with platform-specific
  LaunchAgent or `systemd --user` registration metadata for installer/helper
  consumption.
- Bundled App resources include `bundled-agent/service-installer/` render
  contracts for platform-specific service definitions and package post-install
  hook inputs. The contracts name the required escaping policy instead of
  shipping raw placeholder-expanded service files.
- Bundled App resources include
  `bundled-agent/service-installer/installer-manifest.json`, which maps each
  supported package format to its selected v1 path, render contract, and
  post-install hook input.
- App release and update manifests expose `serviceInstallerBundle` metadata so
  package artifact inputs can be discovered before extracting the App artifact.
- macOS App release artifacts are emitted as `.pkg` installers. The pkg payload
  installs `Butler.app` under `/Applications`, includes the bundled Agent
  resources, and uses the packaged post-install hook input.
- The dependency closure lists
  `background-service-registration-metadata` as an App-owned dependency.
- Current v1 installer requirements are declared as:
  - macOS: `macos-pkg-launch-agent` with `pkg`.
  - Linux: `linux-deb-owned-user-unit` with `deb` and `rpm`, targeting the
    package-owned `/usr/lib/systemd/user/butler.service` unit path.
- Linux service installer resources include
  `service-installer/linux/launcher/butler-app-managed-agent-service`; package
  builders install it at `/usr/lib/butler/butler-app-managed-agent-service` so
  the package-owned user unit can start the active App-managed Agent runtime
  selected by `$BUTLER_DATA/app/runtime/agent/current.json`.
- Linux service installer package staging can generate the Debian control tree,
  RPM spec input, package-owned `systemd --user` unit, launcher, and post-install
  hooks from the bundled service-installer resources.
- Linux service installer package building can invoke `dpkg-deb` and `rpmbuild`
  against the staged package trees and returns the generated `.deb` and `.rpm`
  artifact paths. These tools are release-runner requirements only and are not
  part of App first-run dependency prompts.
- The release workflow publishes Linux App service installer `.deb` and `.rpm`
  artifacts, plus checksum files, from an Ubuntu runner after the Linux App tar
  artifact is available in the GitHub Release.
- App release and update manifests expose published service installer package
  asset names and checksum asset names for macOS `pkg` and Linux `deb`/`rpm`
  formats.
- Packaging smoke verifies the service capability metadata is present beside
  the bundled Agent runtime and release manifests.
- Packaging smoke verifies the service registration metadata is present inside
  packaged App resources.
- Packaging smoke verifies the service installer render contracts are present inside
  packaged App resources and covered by the dependency closure digest.
- Packaging smoke verifies the service installer manifest declares macOS `pkg`
  and Linux `deb`/`rpm` package artifact inputs without adding first-run host
  tool requirements.
- Manual installer smoke can execute the macOS `.pkg` installation path against
  a test-only package and then launch the installed App into the first-run
  service setup flow.
- Release manifest validation rejects missing service installer bundle metadata
  on the top-level App release, component, and artifact records.

Remaining:

- Configure production macOS Developer ID signing and notarization credentials
  for `.pkg` publication.
- Add Windows release platform and installer path after the Windows
  user/security-context implementation.
- Run production-signed installer E2E on each target OS.

## Phase 7: End-To-End Verification

Goal: prove the product behavior users will rely on.

Tasks:

1. E2E: first-run installs service and reaches workspace.
2. E2E: close window, service remains online.
3. E2E: quit UI, service and menu bar helper remain online.
4. E2E: quit menu bar helper, service remains online.
5. E2E: Stop Agent terminates process group.
6. E2E: standalone Agent install remains headless by default.
7. E2E: update Agent runtime restarts process group.
8. E2E: failed update rolls back.

Acceptance:

- No production App path relies on an Electron-owned Agent child process.
- Background consolidation can continue while the UI is closed.
- The App-owned menu bar helper remains available after the main UI exits.
- Standalone Agent installs do not create desktop UI by default.
- Service diagnostics are available when the UI is reopened.

Implemented surface:

- `tests/unit/app-background-service-e2e.test.ts` covers the local product
  contract with a fake service adapter:
  - first-run installs and starts the background Agent service before gateway
    readiness.
  - tray state derives Start/Stop/Restart availability from service-control
    status.
  - runtime update prepare/apply promotes a readiness-confirmed candidate.
  - explicit runtime update rollback restores the previous active pointer.

Remaining:

- Real first-run service install E2E on macOS/Linux against packaged App
  artifacts that register actual user services.
- Real installer-from-package E2E on macOS/Linux against production-style
  signed/notarized App artifacts.
- Real close-window, quit-UI, and quit-helper persistence E2E against an
  OS-managed service.
- Real standalone headless install E2E proving no tray/menu helper is installed
  by default.
- Real Stop Agent process-group termination E2E.
- Real app update restart/rollback E2E with previous and next packaged
  runtimes.

## Initial Implementation Order

1. Phase 0 baseline contracts and platform registration decision gate.
2. Phase 1 App-managed service specs.
3. Phase 2 service-control bridge.
4. Phase 3 first-run service setup.
5. Phase 4 persistent menu bar helper.
6. Phase 5 update/restart/rollback.
7. Phase 6 installer packaging.
8. Phase 7 cross-platform E2E.

This order keeps the runtime contract stable before UI and installer work start.
