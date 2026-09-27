/// <reference types="bun" />
import { expect, test } from "bun:test";
import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";
import { renderToStaticMarkup } from "react-dom/server";
import type { QueuedMessageRecord } from "@/app/types.ts";
import { QueuedMessageItem } from "./QueuedMessageItem";

const record: QueuedMessageRecord = {
  id: "q-1",
  chat_id: "chat",
  text: "Add screenshots to the report.",
  controls: { model: "m", reasoning_effort: "medium", access_mode: "full_access", plan_mode: false },
  state: "queued",
  cursor: 1,
  created_at: "2026-09-25T00:00:00.000Z",
  updated_at: "2026-09-25T00:00:00.000Z",
};

test("the product queued row offers edit and delete but not send now (pending a gateway API)", () => {
  const html = renderToStaticMarkup(
    <QueuedMessageItem
      item={{ key: "q-1", record, tone: "queued", position: 1, total: 2 }}
      queue={{ entering: new Set(), actions: { edit: () => undefined, remove: () => undefined } }}
      virtualRow={{ index: 3, start: 120 } as VirtualItem}
      topOffset={0}
      rowVirtualizer={{ measureElement: () => undefined } as unknown as Virtualizer<HTMLDivElement, Element>}
    />,
  );
  expect(html).toContain("Add screenshots to the report.");
  expect(html).toContain('aria-label="Edit queued message"');
  expect(html).toContain('aria-label="Delete queued message"');
  expect(html).not.toContain("queued-message-send-now");
});
