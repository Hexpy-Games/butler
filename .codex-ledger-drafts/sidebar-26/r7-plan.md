# r7 Sidebar controls and language authority

Accepted intent: latest user request on 2026-09-08. Sidebar layout changes are
presentation-only. Interface language and assistant response language are distinct
settings; changing interface language must never rewrite response preference.

## Spec / observable contract

- Two-line rows: title/actions share row one; location and time/progress share
  row two. Trailing time reaches the right text inset, independent of action width.
- Trailing action hit targets meet the row's right edge (their own internal padding
  supplies icon inset). Their background uses the same rectangular control radius
  as the row, not a circular surface. Preserve mobile long-press and hover replacement.
- Auto-created groups are ordinary groups: no smart sparkle, no special smart
  opt-out identity/action. Keep normal group management and global auto-group setting.
- Running explanatory footer is removed. Add-group appears only in All.
- All shipped interface copy, including deterministic activity/status text from the
  agent, goes through one central locale catalog/API; locale-key parity is checked.
  Do not translate user text, model-authored content, identifiers, or diagnostics
  intended only for developers. Existing interface catalogs must be reused/migrated,
  not shadowed by per-feature dictionaries. Audit exclusions explicitly.
- Model context and deterministic assistant replies use response language, never UI
  language. Explicit language requests in the current user message can override the
  default. UI language changes neither persist nor indirectly select response language.
  Inspect the actual general session and settings before any operational correction;
  do not rewrite user history or infer a new preference from a screenshot alone.

## Execution

1. Implemented, in integration review (root): sidebar geometry and response-language root-cause trace/fix.
2. Active (Astra medium, user-authorized): central i18n audit/migration and tests.
   Ownership excludes root's sidebar files and response-context/settings policy files.
   Report central API early so root can localize its own changed surfaces.
3. Pending: integrate, focused regressions for UI geometry and crossed language
   preferences, real client verification, whole-goal review, main/operational rollout.

Validation is based on the actual settings → context and UI paths. No provider calls
are needed for pure translations; model response policy additionally needs a bounded
real provider/client check. Don't claim a grep scan or source-string test alone proves
every surface. Record found categories, changed owners, exclusions, and residuals.

## Root review and evidence (2026-09-08)

- Sidebar presenter uses a full-width `meta` row. Actions retain their own hit
  target while no longer reserving a column in metadata. Only sidebar opts into
  IconButton's parent-matching rectangle radius; unrelated circular controls retain
  their existing default. Existing sticky clipping and mobile long-press remain.
- Actual browser smoke at 1440/800/390/320 checks action/right-edge equality,
  metadata/time alignment, matching row/action radius, no Recent/Running add
  control, and no Running explanatory footer. It also covers previous nested
  sticky clipping and terminal-event spinner removal without reload. All pass.
- Root cause: preferences-store implicitly initialized responseLanguage from UI
  language; personalization/context/canned-message readers also fell back to UI
  language. Guided turn, EOL, and persona reminders unconditionally mandated the
  configured language, conflicting with explicit user translation requests.
- Removed those UI-to-response dependencies and made one shared instruction
  specify a default with explicit user-language/translation precedence.
- Public HTTP settings/personalization tests exercise the actual store and
  PromptAssembler for Butler, Steward, and Worker with crossed en/ko settings.
- Real isolated Electron, actual production native executor, configured
  `openai/gpt-6-astra`, public client settings API and composer:
  UI=en/response=ko + English rainbow prompt -> Korean answer (12 s);
  UI=ko/response=en + Korean wind prompt -> English answer (11 s);
  same response=en + explicit Korean rewrite request -> Korean answer (10 s).
  No fake provider/history/result injection. A snow prompt sent before a failed
  settings command was corrected is not counted as the crossed-setting test.
- These live examples verify the reported language conflict, not a universal
  proof of probabilistic model compliance. Authored history is not rewritten.
- Broader existing BTCC phase suites: 38 pass/12 fail at pre-existing fixture
  admission/policy-version assertions, before the changed language behavior.
  No unrelated lifecycle changes made to satisfy those assertions.
- Remaining: central locale audit/integration, final static gates and locale
  switching client checks, spec/report closeout, merge and operational rollout.
- Settings-control browser smoke now passes en→ko without reload: translated
  navigation cache/metadata refresh, authored titles and composer draft remain,
  persisted response language stays ko. Screenshots `.tmp/sidebar-r7/locale-*.png`.
- Synthetic compaction notices now keep event kind, render/copy current central
  copy by locale, and choose their icon/style by event provenance instead of an
  English-text regex. Real event reducer test passes (1 test, 8 assertions).
- Integration audit found actual guided-tool ingress hardcoded `ko`, bypassing
  generic operation-title fallback. Closed by generated field references through
  the real guided event, normalizer, merge, SQLite current-status and UI paths.
- Root also closed worker/Steward summary refs and dynamic document option/metadata
  catalogs. Locale switch preserves authored values. Root regressions: 21/157,
  worker/document locale 2/14, compaction 1/8, capsule placement 1/23,
  continuous observer history 1/19. Final build/viewport/settings smoke passed.
- Whole-goal review: no extra role loop, translated-text matching or UI remount.
  Details and exclusions are in r7-i18n-audit.md and validation-report.md.
