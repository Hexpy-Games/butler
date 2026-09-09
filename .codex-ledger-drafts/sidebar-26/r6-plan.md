# r6 Transparent sticky clipping

Intent: Electron vibrancy remains visible, but scrolling session text cannot
paint or receive pointer input behind the pinned browse/group headers.
Authority: latest user approval; spec §23 supersedes §22's blur-only occlusion.
Path: SpaceSidebar → SidebarShell → CollapsibleNavGroup → native scroll/paint.
Non-goals: runtime/session changes, opaque replacement backgrounds, duplicate
headers, a second scrollbar, wheel interception, scroll-driven React renders.

1. Done: implement root/branch clipping and regression smoke on the real UI.
2. Done: review nested pin/unpin, focus, resize, fast scrolling, mobile and
   Electron appearance; run focused DS checks.
3. Done: publish spec/report, commit and reflect the validated UI in main and
   the running app without interrupting agent work for a renderer-only change.

Implementation ac898e16 is on origin/main. The gateway serves the new built
assets and the running Electron Vite renderer reflects the same source.
Focused product checks pass. DS group fixture screenshots are blank and are
not counted as visual acceptance; actual nested product UI is the acceptance path.
