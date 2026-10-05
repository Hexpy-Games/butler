# Settings review: implementation spec

**Status:** approved by the owner (rounds 1–3, 2026-10-05/06). **Design branch:** `design/settings-review`.
**Live proposal:** DS site `?proposal=settings-review` (source `packages/butler-app/client/ui/ds-site/proposals/settings-review/`). It renders the real Settings shell and app shell with fixtures; every piece it changes is a labelled "PROPOSAL COPY" or "NEW" file. Use it as the visual reference and copy JSX from it. Do not ship anything from `ds-site/`.
**Issues:** #483 (update progress), #519 (granted approvals), #218–#221 follow-up (settings errors). **Prior branches:** `origin/codex/update-progress`, `origin/codex/reduce-motion`.

Work items, each one PR (or one batch PR, per the CI policy):

1. [Updates in Settings](#1-updates-in-settings)
2. [Update row in the sidebar + native window progress](#2-update-row-in-the-sidebar--native-window-progress)
3. [Reduce motion](#3-reduce-motion)
4. [Settings errors and inline field errors](#4-settings-errors-and-inline-field-errors)
5. [Security reorganisation + plan-mode move](#5-security-reorganisation--plan-mode-move)
6. [Approved actions (허용한 작업) + backend endpoint](#6-approved-actions-허용한-작업--backend-endpoint)
7. [DS gaps](#7-ds-gaps) (DS primitives are frozen: each gap needs owner approval before a DS change)
8. [Verification](#8-verification)
9. [Copy (i18n keys)](#9-copy-i18n-keys)

Global rules that apply to every item:

- Product UI only from `@/butler-ds`; no new CSS, no className/style on DS components, motion only inside the DS.
- **Minimal move:** a moved setting keeps its component, field order, handler and states. Only where it renders changes.
- Copy: every string is an i18n key in `packages/butler-i18n` (`copy-contract.ts`, `ko.ts`, `en.ts`); KO and EN in §9. Never render a backend message, an error code, a capability id or a tool id.
- Toasts are one line (`notifyStatus(message, { tone: "error" })`); no second "description" line with server text.
- Perf budget for every Settings interaction (open a page, toggle a switch): ≤150 ms to interactive, no long task >50 ms, measured after Settings has loaded, at owner scale (600+ chats). Idle disk writes stay ~0.
- Tests: E2E/smoke first (stub tier, isolated `BUTLER_DATA`). No unit tests or screen recordings for UI.

---

## 1. Updates in Settings

Start from `origin/codex/update-progress` (keep its agent progress snapshot, revision fence, `updates.progress` event, `/updates/cancel`, `useUpdateProgressStore`). Replace its UI.

**Files:** `components/settings/UpdateComponentRow.tsx` (replace `UpdateProgressPanel.tsx` with the row below; delete the panel), `components/settings/UpdatesSettings.tsx`, new `components/settings/updateBytes.ts` (formatter), `packages/butler-i18n` keys `settings.updateProgress.*`, `settings.updateErrors.*` (§9). Reference: `ds-site/.../updates/UpdateRowProposal.tsx`.

**Row** (same as main: `Field` > row `Stack` with `FieldLabel` + version `Typo.Caption` on the left and ONE `Button size="sm"` on the right; keep `data-test-id="update-component-<id>"`). Version text stays `current -> available` as on main.

| Stage (`progress.stage`) | Under the version | Under the row | Button |
|---|---|---|---|
| none / idle, update available | – | – | 업데이트 (default) |
| none / idle, up to date | – | – | 최신 (outline, disabled) |
| `checking` | status line: `Spinner size=12` in `IconSlot size="sm"` (row `cross="center"`) + caption 확인 중 | – | none |
| `downloading`, `bytes_total > 0` | – | `ProgressMeter label=다운로드 중 value=percent meta="{percent}% · {done} / {total}"` | 취소 (outline) when `cancellable` |
| `downloading`, total unknown | status line: spinner + "다운로드 중 · {done} 받음" | – (no fake bar) | 취소 (outline) when `cancellable` |
| `verifying` | status line: 파일 확인 중 | – | none |
| `ready` | caption 다시 시작하면 적용됩니다. | – | 다시 시작 (default) |
| ready but deferred (`useAppUpdateState` `deferred`) | caption = existing `updateDeferred` | – | existing `updateAfterWork` (outline, disabled) |
| `applying` / `restarting` | status line: 다시 시작하는 중 | – | none |
| `failed` | – | `Notice tone="error" icon={<CircleAlert/>} message=<updateErrors.*>` | 다시 시도 (default) |

- The button only ever shows the action available now; the stage name is never a button label.
- Cancel is not a failure: on `update_cancelled` the row returns to "update available" and a toast `settings.updateProgress.cancelled` confirms.
- Remove from the codex UI: the idle panel ("업데이트 대기", "확인 완료"), the speed line, "진행률을 제공하지 않습니다.", the duplicate stage label, the separate cancel `ButtonContainer`, the 1024-based `formatBytes`.
- Bytes: `formatUpdateBytes(bytes, locale)` = `Intl.NumberFormat(locale, { style: "unit", unit: "megabyte", unitDisplay: "short", maximumFractionDigits: mb < 10 ? 1 : 0 }).format(bytes / 1e6)`.
- Error code → copy (`settings.updateErrors.<key>`):
  - `download`: `update_http_unavailable`, `update_artifact_unavailable`, `update_manifest_unavailable`
  - `damaged`: `update_artifact_sha256_mismatch`, `update_manifest_sha256_mismatch`, `update_signature_unsupported`
  - `incompatible`: `update_manifest_incompatible`, `update_manifest_app_platform_missing`, `update_manifest_agent_platform_missing`
  - `storage`: `update_stage_unavailable`, `update_stage_path_invalid`
  - `apply`: `update_activation_failed`
  - `generic`: anything else
- The header "확인" button and the preview switch are disabled while a stage other than idle/failed/ready runs (as on the codex branch).

## 2. Update row in the sidebar + native window progress

**Placement (owner choice):** a row in the sidebar footer, directly above 설정, visible only while `progress.stage` is not idle (running, ready, failed). No capsule above the composer, no titlebar indicator, no badge on 설정.

**Files:** new `components/layout/SidebarUpdateItem.tsx`; `components/space/SpaceSidebar.tsx` (footer); `client/electron/preload.cjs` + `client/electron/main.mjs` (native progress); i18n `shell.*` keys (§9). Reference: `ds-site/.../shell/UpdateIndicators.tsx`, `shell/ShellProposal.tsx`.

**Footer composition** (`SpaceSidebar` `footer` prop):

```tsx
footer={
  <SidebarNav ariaLabel={appCopy.shell.footerNav}>
    <SidebarUpdateItem />
    <SidebarSettingsItem />
  </SidebarNav>
}
```

`SidebarNav` is the same group container `SpaceHeader` uses for 새 대화 / 검색, so the two rows sit `--sidebar-row-spacing` apart (4px desktop/comfortable, 8px phone/touch, ½·xs compact) like every other group. `SidebarSettingsItem` is unchanged. When `SidebarUpdateItem` renders null the footer is pixel-identical to main.

**`SidebarUpdateItem`**: one `NavRow` line (never two lines, no `meta`). It uses the DS `ProgressRing` (`components/ProgressRing`, from `ds/progress-ring` b890192ab): `value` is a 0–1 fraction, always `size="sidebar"` and `aria-hidden` (the row carries the name).

| Stage | `icon` | `label` | `badge` | `actions` |
|---|---|---|---|---|
| `downloading`, total known | `<ProgressRing size="sidebar" value={fraction} aria-hidden />` | 업데이트 받는 중 | `{percent}%` | – |
| `downloading`, total unknown, `checking`, `verifying`, `applying`, `restarting` | `<ProgressRing size="sidebar" indeterminate aria-hidden />` | 업데이트 받는 중 / 업데이트 준비 중 | – | – |
| `ready` (and deferred) | `<ProgressRing size="sidebar" value={1} tone="success" aria-hidden />` | 업데이트 준비됨 | – | `<ButtonContainer size="icon-sm" wrap={false} onPointerDown/onClick={stopPropagation}><IconButton label="다시 시작"><RotateCcw /></IconButton></ButtonContainer>` (only when ready, not deferred) |
| `failed` | `<CircleAlert />` (status icon, no ring: there is no progress to show) | 업데이트 실패 | – | – |

Row details (measured in the proposal, 1280 / 375, light and dark):

- **Row background.** Unchanged NavRow behaviour: transparent at rest, the normal NavRow hover fill on hover (`--selection` at 60%: `rgba(32,35,39,.07)` light, `rgba(255,255,255,.08)` dark). The row is never `active`.
- **Restart action = the DS NavRow action pattern, exactly.** The DS defines one kind of NavRow trailing action: icon-only `IconButton`s in a `ButtonContainer size="icon-sm"` that stop propagation (`NavRow.guidance.tsx` recipe with `OverflowActionMenu`; product: `SpaceRowActions.tsx`, `SidebarChatsSection.tsx`). `ListRow` has no trailing action slot. No DS showcase, guidance or product row puts a text button in a NavRow, so the round-3 outline button and a ghost text button would both be invented styles. Use the IconButton pattern with `RotateCcw`; its `label` ("다시 시작") is the accessible name and the tooltip. A labelled text action is DS gap §7.8.
- **Measured, identical to the existing project-row action in the same sidebar:** `IconButton` = `Button variant="ghost" size="icon-sm"`, 30×30 desktop / 44×44 touch (= row height, vertical inset 0), radius 8px, no border, transparent fill at rest and on hover (the shell's `--icon-button` surface shows the hover), glyph 16px / 20px, colour `--text-secondary` → `--text-primary` on hover (light `rgb(105,109,115)` → `rgb(34,35,38)`; dark `rgb(181,184,189)` → `rgb(242,243,244)`). Inset: `SidebarShell` sets `--nav-action-edge-offset: -8px`, so the target's box ends at the row edge and the glyph ends 7px from the right (12px touch), mirroring the ring/gear start inset of 8px.
- The action calls `stopPropagation` (pointerdown and click) and runs the same handler as the Settings row's 다시 시작.
- **Ring vs gear.** Both are 16×16 desktop and 20×20 touch, at the same x. Ready uses `tone="success"` (green), not a full accent circle. Remaining difference: stroke weight; see §7.1.
- **Group spacing.** The update row and 설정 are 4px apart desktop / 8px touch, identical to the 새 대화 / 검색 group gap. The footer's existing 10px top padding still separates the group from the list.
- `onClick` opens Settings › 업데이트 (`openSettings("updates")`). `ariaLabel` = label + percent.
- Data: `useUpdateProgressStore` (fed by `updates.progress` events, plus one `GET /updates` snapshot after the gateway connects so a download that survives a reload shows). Select `{ stage, percent }` with the percent rounded to an integer so the row re-renders at most once per percent. No timers, no polling.

**Native window progress** (so a collapsed sidebar or a hidden window still shows it; no renderer UI):

- `preload.cjs`: expose `setUpdateProgress(value: number | "indeterminate" | null)`.
- `main.mjs`: `mainWindow?.setProgressBar(value === null ? -1 : value === "indeterminate" ? 2 : value)`. Electron: values >1 are indeterminate on Windows and clamp elsewhere; on macOS send only known values (indeterminate → `null`). Linux: no-op unless the launcher supports it.
- The renderer calls it from the same store subscription, only when the integer percent or the stage changes; `null` on idle, failed, ready-dismissed and on app quit.

## 3. Reduce motion

**Placement (owner choice A):** a new Settings › 모양 section 접근성 directly after 홈 화면, holding one `SettingsField` + `Switch` 동작 줄이기 (description "끄면 시스템 설정을 따릅니다."). Reference: `ds-site/.../motion/AppearanceProposal.tsx`, `ReduceMotionField.tsx`, `HomeScreenFieldsProposal.tsx`.

- Keep from `origin/codex/reduce-motion`: the `reduce_motion` setting (gateway view, sanitize, validation, event payload), `setReducedMotionOverride`, the DS `prefersReducedMotion`/`subscribeReducedMotion` root scope, the PostCSS `@scope` counterparts, copy keys.
- Schema: `appearance: [theme, sidebar, home-screen, accessibility{reduce-motion}]` (not inside `theme` as on the branch).
- While motion is reduced (app switch on or OS `prefers-reduced-motion: reduce`): 홈 화면 › 움직임 renders off + disabled with `Tooltip label="동작 줄이기가 켜져 있어 멈춰 있습니다"`, and 배터리 사용 시 멈춤 hides (as when 움직임 is off). The stored `wallpaper.motion` value is not changed.
- OS reduction on + app switch off: the switch renders on + disabled with tooltip "시스템 설정에서 켜져 있습니다" (the app can only add reduction).
- **Why the branch measured 368 ms (budget 150 ms), fix:**
  1. The smoke timed the first 모양 open right after `page.goto`, while `startApp()` blocked first render on `GET /settings`. Measure open and toggle separately, after Settings is loaded, at owner scale; do not block first render on `/settings` (use the cached setting and reconcile).
  2. The toggle did three synchronous things in one task: PATCH → `setSettings` (whole-settings re-render), a `data-motion` flip on `<html>` (document-wide style recalc via the `@scope` roots and `--motion-*` on `:root`), and every `subscribeReducedMotion` callback in one MutationObserver turn (wallpaper still redraws, thinking-mark loops). Fix: flip the switch optimistically; apply `data-motion` in a `requestAnimationFrame` after commit; scope the attribute and the generated `@scope` rules to the app shell element instead of `<html>` (only `tokens.css` keeps a root counterpart); wallpaper engines read one store selector instead of one MutationObserver each and switch to still on the next frame.
- Budget: open ≤150 ms and toggle ≤150 ms, no long task >50 ms; gate both numbers in `tests/smoke/reduce-motion-smoke.ts`.

## 4. Settings errors and inline field errors

**Rules:**
- A field the agent can reject shows its error directly under its control: `FieldError` (role alert) with `aria-invalid` + `aria-describedby` on the control; focus the first invalid field on save; the error clears on edit. Pattern on main: `SecurityAllowedHostsField.tsx`.
- Everything else is a one-line toast with a mapped key. The renderer maps error code → i18n key; unknown codes map to the action's generic key. Never show `error.message` from the server.
- The agent returns a specific `code` per cause.

**Changes (file → fix):**
- `app/notifications.ts:47` `notifyError`: drop the `description: safeErrorMessage(...)` line; callers pass a mapped key. Add `errorCopy(error, fallbackKey)` that looks up `apiErrorCode(error)` in a per-feature map.
- MCP (`components/settings/useMcpSettingsActions.ts:17`, `McpServerForm.tsx`, `StdioFields.tsx`, `HttpFields.tsx`): replace English-message matching with code mapping; inline errors on ID, command and URL (reference `ds-site/.../errors/McpFormProposal.tsx`). Agent (`butler-gateway/src/gateway/application/mcp_servers.rs:19`, `:48`): map `McpRegistryError` variants to `mcp_server_id_required`, `mcp_command_required`, `mcp_url_required`, `mcp_server_not_found` (404), `mcp_config_invalid`, `mcp_secret_unreadable`; keep `mcp_server_save_failed` / `mcp_server_update_failed` for the rest. Remove/toggle/probe failures get toasts (`settings.mcpErrors.*`).
- Skills import (`SkillsSettings.tsx`): `FieldError` under the import actions with `settings.skillErrors.*` (codes `skill_archive_invalid`, `skill_archive_path_invalid`, `skill_path_invalid`, `skill_file_too_large`).
- Wallpaper module import (`hooks/useWallpaperModules.ts:53`): stop toasting the gateway's first message line; map codes to `settings.wallpaper.*` and show them as a field error under the picker (needs §7.5; until then a one-line toast with the mapped key).
- Wallpaper image upload (`hooks/useWallpaperAssets.ts`): map `wallpaper_unsupported_type`/`wallpaper_image_invalid`/`wallpaper_dimensions_unsupported`/`wallpaper_too_large`.
- Archives (`ArchivesSettings.tsx:35` loadMore, `:49` restore): add catch + toast `settings.archiveErrors.*`.
- Settings save (`stores/settingsUIStore.ts:256`): toast `settings.errors.saveFailed`; keep the `settings_model_unavailable` special case.
- Local models: discovery failure as a field error under the address; registration as a toast.
- Skill rows (`SkillGroup.tsx:28`): `meta` shows the localized source label, not `core`/`user`/`project`.

## 5. Security reorganisation + plan-mode move

**Final Security page order** (`components/settings/SecuritySettings.tsx`; reference `ds-site/.../approvals/SecurityPageProposal.tsx`):

1. 원격 접속 (`remote-access`): unchanged.
2. 기기 연결 (`device-pairing`): unchanged, only when remote access is on.
3. 연결된 기기 (`paired-devices`): unchanged, only when remote access is on.
4. 권한 (`permissions`): **access mode only**, the `SettingsSelect settingId="access-mode"` from `PermissionsFields`, unchanged.
5. 허용한 작업 (`grants`): new, §6.
6. 저장된 키 (`saved-keys`): the `SettingsSection` + `SavedKeysRows` + `useSavedKeys` block from `ModelsSettings.tsx`, unchanged (hidden when `unsupported`).
7. 진단 (`diagnostics`): the section from `PrivacySettings.tsx`, unchanged.
8. 고급 (`security-advanced`) + 허용 호스트 (`allowed-hosts`): unchanged, last.

**Moves:**

| From | To |
|---|---|
| 모델 › 권한 › 접근 권한 (`access-mode`) | 보안 › 권한 |
| 모델 › 권한 › 계획 모드 기본값 (`plan-mode-default`) | 일반 › 대화 입력, last field (after multiline send) |
| 모델 › 저장된 키 (`saved-keys` section) | 보안 › 저장된 키 |
| 개인정보 › 진단 (`diagnostics` section) | 보안 › 진단 |

- `PermissionsFields.tsx` goes away: its `SettingsSelect` JSX moves into `SecuritySettings`, its `SettingsSwitch` JSX into `GeneralSettings` (reference `ds-site/.../approvals/GeneralPageProposal.tsx`). Both keep `useButlerModels`/`settingsUIStore.update` handlers.
- The 개인정보 (Privacy) page is removed: delete `PrivacySettings.tsx`, drop `privacy` from `settingsSectionIds.ts`, `settingsSections.tsx`, `SettingsDetailContent.tsx`, `SettingsSectionId`; `normalizeSettingsSectionId` maps `privacy`/`개인정보`/`diagnostics` to `security` (deep links, command palette).
- Security description → `settings.sectionDescriptions.security`; add the §9 aliases so the sidebar search and palette still find 개인정보, 진단, API 키, 권한.
- `settingsPageSchema.ts`: `general.conversation-input.fields += "plan-mode-default"`; `models` loses `saved-keys` and `permissions`; `privacy` removed; `security = [remote-access, device-pairing?, paired-devices?, permissions{access-mode}, grants, saved-keys, diagnostics{diagnostics}, security-advanced?, allowed-hosts?]`.
- Refused states: `/security` answers only on this computer. On `host-only` / `admin-required` / `error`, only the remote-access section shows its state message; sections 4–7 still render (they never used `/security`); pairing, devices, advanced and hosts stay hidden.
- Models page keeps: 버틀러 모델, 예비 모델, 고급 (memory cleanup, worker profiles). Model add/edit still reads the same saved keys (`useSavedKeys`).
- Not moved (stay where they are): 일반 › 검색 API 키 (paired with the search provider), MCP env/header secrets (part of each server form), 서버 › 연결, 정보 › 개발자 모드, 개발자 로그.
- The composer permission menu is unchanged: the three access modes only, no granted-items section, submenu or count (#519).

## 6. Approved actions (허용한 작업) + backend endpoint

**UI files:** new `components/settings/GrantsSection.tsx`, `GrantRow.tsx`, `grantRows.ts` (kind map + dedupe), `useGrants.ts`; rendered by `SecuritySettings` (§5, item 5). Reference: `ds-site/.../approvals/ApprovalsProposal.tsx`, `GrantRowView.tsx`, `grants.ts`.

**Section:** `SettingsSection id="grants" kind="list" title=허용한 작업 description="묻지 않고 실행하도록 허용한 작업입니다."` with `state` loading / error (`settings.grants.loadFailed`, Retry) / empty (`settings.grants.empty`) / ready.

**Row** (`CardList` > `CardListItem`, as the MCP and skill lists):
- `icon`: by kind: command `Terminal`, fileWrite `PencilLine`, network `Globe2`, tool `McpServer`, other `ShieldCheck`.
- `title`: friendly kind (`settings.grants.kind.*`); never the capability id.
- `meta`: date, `Intl.DateTimeFormat(locale, { month: "short", day: "numeric" })` of the newest `created_at` in the row.
- `description`, two lines:
  1. Exact target in `Typo.Code`, one line, `truncate`. Full text in a `Tooltip` on hover. The target is wrapped in `Clickable variant="text"`; tap or Enter expands it in place (`wrap="anywhere"`, `aria-expanded`). Multi-path targets (newline-joined) show the first path truncated and all paths when expanded. Empty target → `settings.grants.targetUnknown`.
  2. `Tag size="sm"` scope (`settings.grants.scope.*`; `tone="warning"` for always) + `Typo.Caption tone="secondary" truncate` "where · folder": conversation title, or "대화 {count}개" for a grouped row, or the project name; then `위치 {cwd}` for commands. Deleted conversation → `settings.grants.deletedChat`.
- `actions`: `IconButton label=허용 해제` with `Trash2`, disabled while that row revokes.

**Behaviour:**
- Kind map (`grantRows.ts`): `run_command`, `run_command_remote_observation` → command; `write_file`, `edit_file` → fileWrite; `web_*`/`fetch_*`/`http_*` → network; `call_mcp_tool` → tool; else other.
- Dedupe: rows group by `(kind, target, cwd, scope, project_id)`; the row keeps every `grant_ref` and `session_id`. Sort by newest `created_at`.
- Revoke: scope `always` → `confirmAction(revokeAlwaysMessage, { title: revokeAlwaysTitle, confirmLabel: 허용 해제, destructive: true, details: [{ label: kind, text: target }] })` first; other scopes revoke at once. Success → remove the row + toast `settings.grants.revoked`; failure → toast `settings.grants.revokeFailed`, row stays.
- Search + kind filter appear only past 8 rows: `Inline` with `Input type="search"` (matches target, cwd, conversation/project title, kind label; locale-lowercase) and `NativeSelect` (전체 + kinds present). No match → `EmptyLine settings.grants.noMatch`.
- Refresh: on section mount, after a revoke, and on `authority.*` timeline events (debounced to one refetch per animation frame). No polling.
- Only `scope: "conversation"` exists in storage today. Render whatever `scope` the API returns; the `project`/`always` paths (including the confirm) are implemented but stay unreachable until the backend stores those scopes (out of scope for #519, which keeps storage and enforcement unchanged).

**Backend (gateway, read + revoke only; storage schema and enforcement unchanged):**

Today: `GET /authority-requests?session_id=` returns `permissions[]` with `grant_ref, capability, target, cwd, title, description` for ONE owner conversation (`butler-agent/src/host/guided/authority_handoff.rs` `list`), and `DELETE /authority-permissions/{grant_ref}?session_id=` revokes one. Storage `btcc_conversation_permissions(grant_ref, owner_session_id, workspace_path, scope_key, title, description, created_at, revoked_at)`; `capability/target/cwd` are re-derived from `btcc_authority_requests` rows (`decision='allowed' AND allow_scope='conversation'`) in `AuthorityService::list_permissions`.

Add:

1. `GET /authority-permissions` → `{ permissions: GrantView[] }`, every non-revoked grant across conversations, newest first.

   ```ts
   interface GrantView {
     grant_ref: string;
     capability: string;            // mapped to a kind by the client, never shown
     target: string;                // "" when the source request record is gone
     cwd: string | null;            // commands only
     scope: "conversation";         // today; "project" | "always" reserved
     session_id: string;            // owner_session_id
     session_title: string | null;  // null when the conversation no longer exists
     project_id: string | null;
     project_name: string | null;
     workspace_path: string;
     created_at: string;            // ISO 8601, already stored, not returned today
   }
   ```

   Implementation: `AuthorityService::list_all_permissions()`: one query `SELECT … FROM btcc_conversation_permissions WHERE revoked_at IS NULL ORDER BY created_at DESC`, then for each DISTINCT `owner_session_id` the existing per-owner `permission_records` query (indexed by `idx_btcc_authority_requests_owner_pending`) to fill capability/target/cwd. Do not scan `btcc_authority_requests` across owners (7 GB at owner scale); no new index needed. The gateway joins `session_title`, `project_id`, `project_name` from the app session read model by `session_id`. Drop `title`/`description` from the response (Korean strings built in Rust, `permission.rs`; the client derives copy from `capability`).

2. `POST /authority-permissions/revoke` with `{ grants: [{ grant_ref, session_id }] }` → `{ revoked: string[] }`, one transaction (a grouped row revokes several grants at once). Keep the existing single DELETE.

3. Errors: `authority_permission_not_found` (already revoked: treat as success and drop the row), `authority_unavailable`.

Perf: the list call ≤50 ms server-side at owner scale (BTCC DB 7 GB); it runs only when Security opens.

## 7. DS gaps

DS primitives and components are frozen. Each item needs owner approval, then the DS process (spec in the ledger, tests, component + README + showcase + guidance, export, `bun run ds:skill-catalog`).

1. **`ProgressRing` sidebar stroke weight (amend `ds/progress-ring`, b890192ab):** the component exists (`components/ProgressRing/ProgressRing.tsx`; value 0–1, `indeterminate`, `size`, `tone`, aria). Measured against the 설정 gear at `size="sidebar"`, the box size and position match (16×16 desktop, 20×20 touch, same x), but the weight doesn't. The ring's stroke is 2.5 units in its 20-unit box (`ProgressRing.module.css` `:where(.ring)` default), which renders 2.0px at 16px and 2.5px at 20px. Hugeicons glyphs use stroke 1.5 in a 24-unit box: 1.0px at 16px, 1.25px at 20px. The ring's outer diameter is (16+2.5)/20 of the box (14.8px at 16) against the gear's ~13.3px. Proposal: `:where(.ring[data-size="sidebar"]) { --progress-ring-stroke: 1.875; }` (1.5px at 16, 1.875px at 20: 1.5× the icon line, which keeps a 42% arc readable), and optionally r 7.5 for `sidebar` so the outer diameter lands at ~13.5px. Owner approval needed (DS frozen); the spec's sidebar row uses whatever the DS ships.
2. **`SettingsField` `error` prop:** `blocks/SettingsField/SettingsField.tsx:23`. `error?: ReactNode` renders `FieldError` under the control and wires `aria-describedby`; today callers put `FieldError` in the control slot.
3. **`ProgressMeter` indeterminate:** `blocks/ProgressMeter/ProgressMeter.tsx:9`. Until then: Spinner status line (§1).
4. **`Switch` `disabledReason`:** `shadcn/ui/switch.tsx:10`, matching `SettingsSelect`'s tooltip behaviour. Until then: wrap the disabled `Switch` in `Tooltip` (§3).
5. **`WallpaperPicker` `importError`:** `blocks/WallpaperPicker/WallpaperPicker.tsx:45`, shown under the import tile (§4).
6. **`IconSlot` caption line height:** `components/IconSlot/IconSlot.tsx:13`. `minHeight="line"` uses the body line, so a glyph beside a caption sits ~3px low; add a caption line option. Until then: `cross="center"` without `minHeight` for one-line caption status rows (§1).
8. **NavRow labelled text action (not defined).** Need: a short verb ("다시 시작") as the row's trailing action where an icon alone is ambiguous. Proposal: `NavRow` `action={{ label, onSelect }}` rendering a DS-owned text action: `Button variant="ghost" size="xs"` height `min(--sidebar-action-size, row)`, radius `--radius-control`, hover fill `--selection`, text `--text-primary` at `--font-size-1`, and its own inset rule: the text box ends at the row's inline padding (8px), not at the edge, so it mirrors the icon's start inset. Until approved, use the icon pattern above.
9. Observation (not a gap request): the 홈 화면 palette `SegmentedControl` clips its labels at 375.

## 8. Verification

No unit tests for UI; smokes/E2E on the stub tier with isolated `BUTLER_DATA`. Compare against the proposal at 375 and 1280, light and dark, KO and EN.

- **Updates:** extend `tests/smoke/update-progress-smoke.ts` (codex branch): drive every stage through the stub feed; assert the button label per stage (table §1), no button during checking/verifying/applying, ProgressMeter only with a known total, error Notice copy per code group, cancel → available + toast. E2E `crates/butler-e2e/tests/update_progress.rs` stays.
- **Sidebar row:** same smoke: row absent at idle (footer geometry identical to main: row 30/44px, 4/8px gaps), present with ring + label + percent while downloading, 다시 시작 when ready, opens Settings › 업데이트; `setUpdateProgress` called only on integer changes, cleared on idle (spy the preload bridge). Owner-scale run (600 chats): no long task >50 ms during a simulated download.
- **Reduce motion:** `tests/smoke/reduce-motion-smoke.ts`: open 모양 and toggle measured separately after Settings loads, both ≤150 ms at owner scale; 움직임 disabled + tooltip while reduced; OS-on state; restart persistence (existing).
- **Errors:** extend `tests/smoke/settings-bugs-smoke.ts`: each MCP code lands under its field with `aria-invalid`; skill and wallpaper imports show the mapped field error; archives restore/load-more failure toasts; no toast contains server text (assert against the stub's English messages); one-line toasts only.
- **Security + plan mode:** a settings smoke opens 보안 in reachable and `loopback_required` states and asserts the section order of §5; 일반 › 대화 입력 holds 계획 모드 기본값 and toggling it persists; 모델 has no 권한 / 저장된 키; `?settings=privacy` deep link lands on 보안; sidebar search "개인정보" and "API 키" find 보안.
- **Approved actions:** E2E (stub tier) creates grants in two conversations with the same command plus one file grant; `GET /authority-permissions` returns all with `created_at` and session titles; the UI shows two rows (one "대화 2개"); revoke of the grouped row calls the batch endpoint once and both grants stop applying (approval asked again). Owner-scale timing for the list endpoint.
- Gates: `bun run typecheck`, `bun run lint:design`, `bun run lint:css` (if CSS changes in DS work), `bun run app:design-system:smoke`, `bun run app:layout:smoke` (sidebar footer change), `ds-site:check`.

## 9. Copy (i18n keys)

All keys go to `packages/butler-i18n/src/copy-contract.ts`, `locales/ko.ts`, `locales/en.ts`. "(on main)" = the key exists; keep it. Codes listed are the backend codes the key replaces (mapped in the renderer). Source of truth during design: `ds-site/proposals/settings-review/proposedCopy.ts`.

#### Updates

| Key | KO | EN | Surface | Replaces codes |
|---|---|---|---|---|
| `settings.updateProgress.checking` | 확인 중 | Checking | row |  |
| `settings.updateProgress.downloading` | 다운로드 중 | Downloading | row |  |
| `settings.updateProgress.downloadMeta` | {percent}% · {done} / {total} | {percent}% · {done} of {total} | row |  |
| `settings.updateProgress.downloadedBytes` | {done} 받음 | {done} downloaded | row |  |
| `settings.updateProgress.verifying` | 파일 확인 중 | Verifying | row |  |
| `settings.updateProgress.ready` | 다시 시작하면 적용됩니다. | Restart to finish. | row |  |
| `settings.updateProgress.restart` | 다시 시작 | Restart | label |  |
| `settings.updateProgress.applying` | 적용 중 | Applying | row |  |
| `settings.updateProgress.restarting` | 다시 시작하는 중 | Restarting | row |  |
| `settings.updateProgress.cancelled` | 다운로드를 취소했습니다. | Download cancelled. | toast | `update_cancelled` |
| `shell.footerNav` | 업데이트와 설정 | Updates and settings | label |  |
| `shell.update.downloading` | 업데이트 받는 중 | Downloading update | row |  |
| `shell.update.working` | 업데이트 준비 중 | Preparing update | row |  |
| `shell.update.ready` | 업데이트 준비됨 | Update ready | row |  |
| `shell.update.failed` | 업데이트 실패 | Update failed | row |  |
| `settings.updateErrors.download` | 업데이트를 받지 못했습니다. 연결을 확인해 주세요. | Couldn't download the update. Check your connection. | notice | `update_http_unavailable`, `update_artifact_unavailable`, `update_manifest_unavailable` |
| `settings.updateErrors.damaged` | 받은 파일을 확인하지 못했습니다. 다시 받아 주세요. | The download didn't verify. Try again. | notice | `update_artifact_sha256_mismatch`, `update_manifest_sha256_mismatch`, `update_signature_unsupported` |
| `settings.updateErrors.incompatible` | 이 기기용 업데이트가 아직 없습니다. | No update for this device yet. | notice | `update_manifest_incompatible`, `update_manifest_app_platform_missing`, `update_manifest_agent_platform_missing` |
| `settings.updateErrors.storage` | 업데이트 파일을 저장하지 못했습니다. | Couldn't save the update file. | notice | `update_stage_unavailable`, `update_stage_path_invalid` |
| `settings.updateErrors.apply` | 적용하지 못해 지금 버전을 유지합니다. | Couldn't apply it. Your current version stays. | notice | `update_activation_failed` |
| `settings.updateErrors.generic` | 업데이트하지 못했습니다. | Couldn't update. | notice | `update_manifest_invalid`, `update_manifest_*`, `update_artifact_*`, `update_status_invalid`, `(other)` |

#### Reduce motion

| Key | KO | EN | Surface | Replaces codes |
|---|---|---|---|---|
| `settings.pageSections.accessibility` | 접근성 | Accessibility | label |  |
| `settings.fields.reduceMotion` | 동작 줄이기 | Reduce motion | label |  |
| `settings.descriptions.reduceMotion` | 끄면 시스템 설정을 따릅니다. | When off, follows your system setting. | label |  |
| `settings.descriptions.reduceMotionSystem` | 시스템 설정에서 켜져 있습니다 | On in your system settings | label |  |
| `settings.descriptions.wallpaperStill` | 동작 줄이기가 켜져 있어 멈춰 있습니다 | Paused by Reduce motion | label |  |

#### Errors

| Key | KO | EN | Surface | Replaces codes |
|---|---|---|---|---|
| `settings.errors.saveFailed` | 저장하지 못했습니다. | Couldn't save. | toast | `invalid_settings_request`, `(any PATCH /settings failure)` |
| `serverErrors.settings_model_unavailable` (on main) | 선택한 모델을 더 이상 사용할 수 없습니다. | That model is no longer available. | toast | `settings_model_unavailable` |
| `settings.mcpIdRequired` (on main) | 서버 ID를 입력합니다. | Enter a server ID. | field | `mcp_server_id_required` |
| `settings.mcpIdInvalid` (on main) | 영문·숫자·점·밑줄·하이픈 1~80자로 입력합니다. | Use letters, numbers, dots, underscores or hyphens (1–80). | field | `mcp_server_id_invalid` |
| `settings.mcpCommandRequired` (on main) | 명령을 입력합니다. | Enter a command. | field | `mcp_command_required` |
| `settings.mcpUrlRequired` (on main) | URL을 입력합니다. | Enter a URL. | field | `mcp_url_required` |
| `settings.mcpErrors.save` | 서버를 저장하지 못했습니다. | Couldn't save the server. | toast | `mcp_server_save_failed`, `mcp_server_update_failed`, `mcp_config_invalid`, `mcp_secret_unreadable` |
| `settings.mcpErrors.notFound` | 이미 삭제된 서버입니다. | This server was already removed. | toast | `mcp_server_not_found` |
| `settings.mcpErrors.unavailable` | MCP 설정을 열지 못했습니다. | Couldn't open MCP settings. | toast | `mcp_registry_unavailable` |
| `settings.mcpErrors.remove` | 서버를 삭제하지 못했습니다. | Couldn't remove the server. | toast |  |
| `settings.mcpErrors.toggle` | 변경하지 못했습니다. | Couldn't change it. | toast |  |
| `settings.mcpErrors.probe` | 연결을 확인하지 못했습니다. | Couldn't reach the server. | toast |  |
| `settings.skillErrors.invalid` | 스킬 .zip 파일이 아닙니다. | That isn't a skill .zip. | field | `skill_archive_invalid`, `skill_archive_path_invalid`, `skill_path_invalid` |
| `settings.skillErrors.tooLarge` | 파일이 너무 큽니다. | That file is too large. | field | `skill_file_too_large` |
| `settings.skillErrors.import` | 가져오지 못했습니다. | Couldn't import it. | field | `(other)` |
| `settings.security.invalidHost` (on main) | 호스트 이름이나 IP를 입력하세요 | Enter a host name or IP | field |  |
| `settings.wallpaper.moduleInvalid` | 월페이퍼 파일이 올바르지 않습니다. | That wallpaper file isn't valid. | field | `wallpaper_module_archive_invalid`, `wallpaper_module_invalid`, `wallpaper_module_request_invalid` |
| `settings.wallpaper.moduleTooLarge` (on main) | 2MB 이하 모듈만 가능 | Modules up to 2 MB. | field | `wallpaper_module_archive_too_large`, `wallpaper_module_file_too_large` |
| `settings.wallpaper.moduleExists` (on main) | 이미 설치된 모듈 | Module already installed. | field | `wallpaper_module_exists` |
| `settings.wallpaper.imageUnsupported` | JPG, PNG, WebP 이미지만 가능 | JPG, PNG or WebP only. | field | `wallpaper_unsupported_type`, `wallpaper_image_invalid`, `wallpaper_dimensions_unsupported` |
| `settings.wallpaper.imageTooLarge` | 이미지가 너무 큽니다. | That image is too large. | field | `wallpaper_too_large` |
| `settings.wallpaper.moduleImportFailed` (on main) | 모듈 가져오기 실패 | Module import failed. | field | `(other)` |
| `settings.archiveErrors.restore` | 복원하지 못했습니다. | Couldn't restore it. | toast |  |
| `settings.archiveErrors.loadMore` | 더 불러오지 못했습니다. | Couldn't load more. | toast |  |
| `settings.localModelErrors.discover` | 이 주소에서 모델을 찾지 못했습니다. | No models found at this address. | field | `local_model_discovery_failed` |
| `settings.localModelErrors.register` | 모델을 추가하지 못했습니다. | Couldn't add the model. | toast | `local_model_registration_failed`, `local_model_update_failed` |
| `firstRun.keyErrors.invalid` (on main) | 이 키로 연결할 수 없습니다. 키를 다시 복사해 붙여 넣으세요. | This key can't connect. Copy it again and paste it. | field | `provider_auth_error`, `credential_key_invalid` |
| `firstRun.keyErrors.noaccess` (on main) | 이 키로는 모델을 쓸 수 없습니다. 결제나 사용 권한을 확인하세요. | This key can't use models. Check billing or access. | field | `provider_permission_error`, `provider_quota_exhausted` |
| `firstRun.keyErrors.network` (on main) | 서비스에 연결할 수 없습니다. 인터넷 연결을 확인하세요. | Can't reach the service. Check your connection. | field | `provider_network_error`, `provider_timeout` |
| `settings.grants.revokeFailed` | 허용을 해제하지 못했습니다. | Couldn't revoke it. | toast | `(DELETE /authority-permissions failure)` |
| `settings.grants.loadFailed` | 허용 목록을 불러오지 못했습니다. | Couldn't load approvals. | notice |  |

#### Security and approved actions

| Key | KO | EN | Surface | Replaces codes |
|---|---|---|---|---|
| `settings.sectionDescriptions.security` | 접속, 권한, 키와 진단 정보를 관리합니다. | Manage access, permissions, keys and diagnostics. | label |  |
| `settings.sectionAliases.security (+)` | 권한, 허용한 작업, API 키, 저장된 키, 진단, 개인정보 | permissions, approvals, API keys, saved keys, diagnostics, privacy | label |  |
| `settings.pageSections.grants` | 허용한 작업 | Approved actions | label |  |
| `settings.pageSectionDescriptions.grants` | 묻지 않고 실행하도록 허용한 작업입니다. | Actions Butler runs without asking. | label |  |
| `settings.grants.kind.command` | 명령 실행 | Run command | label |  |
| `settings.grants.kind.fileWrite` | 파일 쓰기 | Write files | label |  |
| `settings.grants.kind.network` | 네트워크 | Network | label |  |
| `settings.grants.kind.tool` | 외부 도구 | External tool | label |  |
| `settings.grants.kind.other` | 기타 작업 | Other action | label |  |
| `settings.grants.scope.conversation` | 대화 | Chat | label |  |
| `settings.grants.scope.project` | 프로젝트 | Project | label |  |
| `settings.grants.scope.always` | 항상 | Always | label |  |
| `settings.grants.conversations` | 대화 {count}개 | {count} chats | row |  |
| `settings.grants.cwd` | 위치 {path} | In {path} | row |  |
| `settings.grants.revoke` | 허용 해제 | Revoke | label |  |
| `settings.grants.revokeAlwaysTitle` | 항상 허용을 해제할까요? | Revoke this always-on approval? | dialog |  |
| `settings.grants.revokeAlwaysMessage` | 다음부터는 실행 전에 묻습니다. | Butler will ask before running it again. | dialog |  |
| `settings.grants.revoked` | 허용을 해제했습니다. | Revoked. | toast |  |
| `settings.grants.search` | 허용한 작업 검색 | Search approvals | label |  |
| `settings.grants.filter` | 종류 | Kind | label |  |
| `settings.grants.filterAll` | 전체 | All | label |  |
| `settings.grants.empty` | 허용한 작업이 없습니다. | No approved actions. | row |  |
| `settings.grants.noMatch` | 검색 결과가 없습니다. | No matches. | row |  |
| `settings.grants.targetUnknown` | 대상 정보 없음 | Target not recorded | row |  |
| `settings.grants.deletedChat` | 삭제된 대화 | Deleted chat | row |  |
