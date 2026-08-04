# Session Paging, Project Dialog, and Windows Test Installer Spec

## Accepted intent

The current Butler test build must present session paging and project creation
with the same Butler design-system language as their surrounding surfaces, and
the exact reviewed revision must be available as a Windows x64 installer in the
user's home folder.

## Authority and ownership

- The Electron renderer owns the session paging row and project-create dialog.
- Butler DS owns navigation-row typography, modal layout, field, input, and
  button presentation. Product components provide copy, state, and actions.
- The existing GitHub-hosted Windows x64 package workflow owns construction and
  package verification. macOS must not bypass the Windows-only packaging gate.
- The parent task owns downloading the verified artifact, checking its digest,
  copying it to `/Users/yeonwoo`, and removing temporary remote build state.

## F1: Session load-more row

- Each direct-chat and project-session list shows at most five initial rows.
- When more sessions exist, the load-more action uses the DS navigation-row
  presentation used by session items: identical label font size, weight, row
  height, horizontal alignment, hover behavior, and responsive typography.
- The label remains `더보기 (N)` and each activation reveals five more rows.
- The action is accessible as a button and has a stable test identifier.

## F2: Project-create dialog

- The dialog uses only Butler DS dialog/form/field/input/button components.
- The title, project-name field, input, and footer are vertically separated by
  DS spacing; the footer remains inside the dialog and right-aligns Cancel and
  Create without overlap.
- The modal stays within the viewport at desktop and compact widths, retains
  focus/escape/outside-close behavior, and blocks duplicate submission.
- Empty or whitespace-only names keep Create disabled. A valid name is trimmed
  and handed to the existing scratch-project creation path.
- A real rendered fixture or Electron smoke must verify computed layout rather
  than relying only on source-string assertions.

## F3: Windows test installer

- Build the exact approved commit as `win32-x64` through the existing Windows
  package workflow and Squirrel packaging path.
- The package remains `distributionStatus: gated`; it is a test installer, not
  a production release and is not published to a GitHub release.
- CI must verify the x64 PE payload, bundled Bun runtime, process host,
  Squirrel package/index, checksums, and internally consistent test signatures.
- Temporary branch/PR state may exist only for the package build and must be
  closed/deleted after the artifact is downloaded.
- Copy the Setup executable and its SHA-256 sidecar to the user's home folder
  with names that include Butler version, `win32-x64`, and `test`.
- The handoff must state that the ephemeral CI certificate is not a production
  trusted publisher and Windows may show SmartScreen/unknown-publisher UI.

## Non-goals and forbidden substitutions

- Do not add raw font sizes, weights, colors, spacing, or one-off modal CSS.
- Do not weaken or remove the Windows-only packaging/signature gates.
- Do not publish a production Windows release or reuse an older installer.
- Do not change session page size, project creation semantics, or App Gateway
  transport behavior.

## Acceptance and validation

1. Component tests exercise the real load-more DS row and project dialog.
2. DS lint, CSS lint, UI typecheck, targeted tests, `git diff --check`, and
   `bun run check` pass.
3. Electron inspection confirms the load-more typography and modal geometry.
4. Sol high review approves the full public path and DS compliance.
5. Windows CI succeeds for the exact commit; the downloaded Setup checksum
   matches its sidecar and both final home-folder files exist.
