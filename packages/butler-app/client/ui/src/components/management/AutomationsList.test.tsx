/// <reference types="bun" />

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { appCopy, setAppCopyLanguage } from "@/app/copy.ts";
import type { AccessMode } from "@/app/types.ts";
import { accessModeIcon } from "@/components/conversation/accessModeUtils";
import { AutomationsList } from "./AutomationsList";

test("the automations list shows skeleton rows, not the empty line, until the first load settles", () => {
  const loading = renderToStaticMarkup(
    <AutomationsList automations={[]} loaded={false} onSelectAutomation={() => undefined} onNewAutomation={() => undefined} />,
  );
  expect(loading).toContain('data-slot="skeleton-rows"');
  expect(loading).not.toContain(appCopy.automations.empty);
  const empty = renderToStaticMarkup(
    <AutomationsList automations={[]} loaded onSelectAutomation={() => undefined} onNewAutomation={() => undefined} />,
  );
  expect(empty).toContain(appCopy.automations.empty);
  expect(empty).not.toContain('data-slot="skeleton-rows"');
});

test("each schedule row shows its access mode with the composer's icon and label", () => {
  setAppCopyLanguage("ko");
  try {
    const row = (access_mode: AccessMode) => renderToStaticMarkup(
      <AutomationsList
        automations={[{ id: "a1", title: "Morning brief", target_label: "A", state: "enabled", interval_seconds: 3600, schedule_type: "interval", access_mode }]}
        onSelectAutomation={() => undefined}
        onNewAutomation={() => undefined}
      />,
    );
    expect(row("ask_first")).toContain("enabled / 1 hour / 먼저 확인");
    expect(row("full_access")).toContain("enabled / 1 hour / 전체 권한");
    expect(row("read_only")).toContain("enabled / 1 hour / 읽기 전용");
    for (const mode of ["ask_first", "full_access", "read_only"] as const) {
      expect(row(mode)).toContain(renderToStaticMarkup(accessModeIcon(mode)));
    }
  } finally {
    setAppCopyLanguage("en-US");
  }
});
