// test-category: pure-logic
import { expect, test } from "bun:test";
import { DocumentSession } from "./DocumentSession";

test("draft changes defer serialization until flush and publish unsaved status once", async () => {
  const session = new DocumentSession("draft");
  session.state = { ...session.state, saved: true };
  let reads = 0, notifications = 0, draft = "first";
  session.subscribe(() => { notifications++; });
  const detach = session.registerDraft(() => { reads++; return draft; });
  for (let index = 0; index < 20; index++) session.draftChanged();
  expect(reads).toBe(0);
  expect(notifications).toBe(1);
  draft = "latest text";
  await session.flush();
  expect(reads).toBe(1);
  expect(session.state.body).toBe("latest text");
  draft = "typed before close";
  session.draftChanged(); detach();
  expect(session.state.body).toBe("typed before close");
  await session.close();
  expect(reads).toBe(2);
});
