import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import type { MessageRecord } from "@/app/types.ts";
import { formatClock } from "@/app/formatClock";
import { AssistantResponseFooter } from "./AssistantResponseFooter";
import { buildAssistantFooterMetaById } from "./messageFooterMeta";
import { UserMessageFooter } from "./UserMessageFooter";

function timeElement(markup: string): HTMLElement {
  const element = new JSDOM(markup).window.document.querySelector("time");
  if (!element) throw new Error("no time element");
  return element as HTMLElement;
}

test("a user message and its reply show the same clock format", () => {
  const at = new Date();
  at.setHours(1, 25, 0, 0);
  const iso = at.toISOString();
  const messages: MessageRecord[] = [
    { id: "u", role: "user", text: "hi", turn_id: "t", created_at: iso },
    { id: "a", role: "assistant", text: "ok", turn_id: "t", created_at: iso },
  ];
  const meta = buildAssistantFooterMetaById(messages, "en-US").get("a") ?? null;
  expect(meta?.timeLabel).toBe(formatClock(at, "en-US"));

  const user = timeElement(renderToStaticMarkup(<UserMessageFooter message={messages[0]!} />));
  const reply = timeElement(renderToStaticMarkup(
    <AssistantResponseFooter copied={false} meta={meta} onCopy={() => undefined} status="completed" />,
  ));
  expect(user.textContent).toBe(reply.textContent);
  expect(reply.textContent).not.toMatch(/^0\d:/u);
  for (const time of [user, reply]) {
    expect(time.getAttribute("data-numeric")).toBe("tabular");
    expect(time.getAttribute("datetime")).toBe(iso);
  }
});
