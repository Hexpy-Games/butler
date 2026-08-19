import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  HARNESS_NAVIGATION,
  HARNESS_SS03_NAVIGATION,
  HARNESS_SS03_SUMMARY,
  HARNESS_SUMMARY,
} from "../../packages/butler-app/client/ui/src/app/fixtures.ts";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(`${root}/${path}`, "utf8");
}

test("Steward UI keeps the neutral capsule and adjunct ordering contract", () => {
  const panel = read(
    "packages/butler-app/client/ui/src/components/conversation/StewardComposerPanel.tsx",
  );
  const adjunct = read(
    "packages/butler-app/client/ui/src/components/conversation/ComposerAdjunctPanels.tsx",
  );

  expect(panel).toContain("작업 중 · ${Math.min(total, completed + 1)}/${total} ·");
  expect(panel).not.toMatch(/percent|gauge|%/iu);
  expect(adjunct.indexOf("<WorkProgressPanel")).toBeLessThan(
    adjunct.indexOf("<QueuedComposerPanel"),
  );
  expect(adjunct.indexOf("<QueuedComposerPanel")).toBeLessThan(
    adjunct.indexOf("<WorkerComposerPanel"),
  );
  expect(adjunct.indexOf("<WorkerComposerPanel")).toBeLessThan(
    adjunct.indexOf("<StewardComposerPanel"),
  );
});

test("observer UI is read-only, session-addressed, and accessible", () => {
  const dialog = read(
    "packages/butler-app/client/ui/src/components/layout/SessionObserverDialog.tsx",
  );
  const sidebar = read(
    "packages/butler-app/client/ui/src/components/layout/SidebarStewardChildItem.tsx",
  );

  expect(dialog).toContain("state.sessionViews[sessionId]");
  expect(dialog).toContain("<DialogTitle>");
  expect(dialog).toContain("<DialogDescription id=\"steward-observer-description\">");
  expect(dialog).toContain("aria-describedby=\"steward-observer-description\"");
  expect(dialog).toContain("aria-label={appCopy.inspector.tabs.activity}");
  expect(dialog).not.toContain("<Composer");
  expect(sidebar).toContain("openSessionObserver(session.id)");
  expect(sidebar).not.toContain("Worker");
});

test("SS-03 fixture data is isolated from the default harness surface", () => {
  const defaultSession = HARNESS_NAVIGATION.projects[0]?.sessions?.[0];
  const ss03Session = HARNESS_SS03_NAVIGATION.projects[0]?.sessions?.[0];

  expect(HARNESS_SUMMARY.steward_children).toBeUndefined();
  expect(defaultSession?.steward_children).toBeUndefined();
  expect(HARNESS_SS03_SUMMARY.steward_children).toHaveLength(1);
  expect(ss03Session?.steward_children).toHaveLength(1);
});
