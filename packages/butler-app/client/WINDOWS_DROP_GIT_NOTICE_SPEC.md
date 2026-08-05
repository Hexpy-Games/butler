# Windows file drop and Git notice dismissal

## Intent lock

- Latest approved intent: a missing-Git notice must be dismissible, and files
  dragged from Windows Explorer must be accepted by the active Composer instead
  of showing the prohibited cursor.
- Governing product path: installed Electron window -> app renderer -> active
  Composer -> existing attachment upload pipeline.
- Design authority: existing Butler design-system `Notice`, `Button`,
  `IconButton`, `Stack`, and Composer surfaces. No parallel visual primitives.
- Non-goals: installing Git, changing Git capability detection, changing file
  upload persistence, relaxing Electron sandboxing, or adding polling.

## Observable contract

### Missing-Git notice

1. When the active session reports `git_not_installed`, the existing warning,
   explanation, and Git installation link remain visible.
2. The notice also exposes an accessible close button using Butler DS controls.
   Korean and English copy provide its screen-reader label, and it is keyboard
   operable through the native button contract.
3. Closing hides the notice immediately for the lifetime of the current renderer
   session. It may appear again after a full app relaunch while Git is absent.
4. Dismissal does not mutate session, project, Git, or durable user settings.
5. The action cluster must remain usable without covering Composer attachments.

### Windows Explorer file drop

1. While an active Composer is mounted, native file drags are accepted at the
   renderer-window capture boundary, including the path across non-Composer
   chrome before the pointer reaches the Composer.
2. `dragenter` and `dragover` for a file payload prevent the browser navigation
   default, advertise the copy drop effect, and activate existing Composer DS
   drop feedback.
3. `drop` prevents navigation, clears feedback, and passes the `FileList` to the
   existing attachment upload path exactly once.
4. Leaving the app window clears drop feedback. Empty file payloads never invoke
   upload.
5. Text, link, and other non-file drags remain untouched.
6. The renderer listener is removed when the Composer unmounts and does not run
   background work while no drag event is present.

## Ownership and state

- `GitDependencyNotice` owns ephemeral dismissal state and maps app copy into a
  domain-neutral presenter.
- `GitDependencyNoticePresenter` owns only DS composition and accessibility.
- `useComposerFileDrop` owns capture listeners, drag depth, feedback state, and
  the single handoff to `onFiles`; the form does not retain a second competing
  drop path.
- `useFileAttachments` remains the sole owner of upload and attachment state.

## Failure and security semantics

- A malformed or missing `DataTransfer` is ignored.
- A file-typed drag with no files is blocked from renderer navigation but is not
  uploaded.
- Existing Gateway authentication, size limits, file-name handling, and upload
  errors remain authoritative.
- No private file path, token, raw payload, or transcript content is logged.

## Platform and lifecycle matrix

- Windows packaged Electron plus Explorer is the required acceptance path.
- The renderer-level contract remains active on macOS, Linux, and browser
  development builds because standard file `DataTransfer` semantics are shared;
  it must not call platform-native or privileged APIs.
- Mounted, dragging, dropped, left-window, and unmounted are the complete hook
  states. Unmount always clears listeners and drag depth; remount starts idle.
- A failed upload remains visible through the existing attachment error path and
  may be retried by choosing or dropping the file again.

## Acceptance evidence

1. Presenter test proves install guidance and accessible dismissal coexist.
2. Container test proves dismissal hides the notice without changing capability
   detection.
3. Hook tests dispatch file drag events outside the form, prove capture-level
   prevention/copy feedback, and prove one upload handoff.
4. Hook tests prove non-file drags and empty file drops do not upload.
5. Targeted tests, lint, typecheck, `bun run check`, and `git diff --check` pass.
6. A rebuilt Windows installer is tested with a real Explorer drag and visible
   Git-notice dismissal in the installed app.
