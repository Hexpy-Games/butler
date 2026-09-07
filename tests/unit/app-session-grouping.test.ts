import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { AppSpaceOrganization } from "../../packages/butler-agent/src/gateways/app/domain/sessions/space-organization.ts";
import { AppSessionTopicGrouping } from "../../packages/butler-agent/src/gateways/app/domain/sessions/session-topic-grouping.ts";
import { boundGroupingInput, classifySession, validateClassification } from "../../packages/butler-agent/src/agent/output/session-grouping.ts";

test("grouping waits beyond three seconds without a timeout or output cap and validates the whole response", async () => {
  const controller = new AbortController();
  let finish!: (value: { text: string }) => void;
  const result = classifySession({ invoke: async request => {
    expect(request.signal).toBe(controller.signal);
    expect(request.tools).toEqual([]);
    expect(request.metadata?.requestedOutputTokens).toBeUndefined();
    return new Promise(resolve => { finish = resolve; });
  } }, { text: "교토 여행", candidates: [], model: "openai/gpt-5.5", signal: controller.signal });
  await Bun.sleep(3100);
  expect(controller.signal.aborted).toBe(false);
  finish({ text: '{"topic":"여행","action":"none","target":null}' });
  expect(await result).toEqual({ topic: "여행", action: "none", target: null });
  expect(validateClassification('{"topic":"두 단어","action":"none","target":null}', [])).toBeNull();
  expect(validateClassification('{"topic":"여행","action":"join_group","target":"invented"}', [])).toBeNull();
  const bounded = boundGroupingInput("가나다".repeat(5000), [], "openai/gpt-5.5");
  expect(bounded.previewTruncated).toBe(true);
});

test("classification groups two matching roots, reuses the group, and preserves manual placement and undo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "butler-grouping-"));
  const server = createTestAppServer({ dbPath: join(dir, "app.sqlite"), butlerData: dir, port: 0 });
  const space = new AppSpaceOrganization(server.store.db, () => {});
  let enabled = true;
  let delayed: (() => void) | undefined;
  let release!: () => void;
  const grouping = new AppSessionTopicGrouping({ db: server.store.db, space, enabled: () => enabled,
    classify: async () => {
      if (delayed) { delayed(); await new Promise<void>(resolve => { release = resolve; }); }
      return { topic: "여행", action: "none", target: null };
    },
  });
  const create = (title: string) => {
    const session = server.store.createSession({ kind: "chat", title }).session;
    const message = server.store.insertMessage(session.id, "user", title, "sent");
    return { session, message };
  };
  const start = (item: ReturnType<typeof create>) => grouping.start(item.session.id, item.message.id, item.message.text, "openai/gpt-5.5");
  try {
    const first = create("교토 여행");
    await start(first);
    expect(space.read().groups).toHaveLength(0);
    const second = create("오사카 여행");
    await start(second);
    const group = space.read().groups[0]!;
    expect(group.title).toBe("여행");
    expect(group.origin).toBe("smart");
    expect(space.read().nodes.filter(node => node.parentKey === `g:${group.id}`)).toHaveLength(2);
    const third = create("도쿄 여행");
    await start(third);
    expect(space.read().groups).toHaveLength(1);
    const notice = space.read().smartNotice!;
    expect(notice.title).toBe("여행");
    space.execute({ action: "undo", expectedRevision: space.read().revision, undoToken: notice.undoToken });
    expect(space.read().nodes.find(node => node.entityId === third.session.id)?.manualPlacement).toBe(true);
    const fourth = create("삿포로 여행");
    let begun!: () => void;
    const ready = new Promise<void>(resolve => { begun = resolve; });
    delayed = begun;
    const pending = start(fourth);
    await ready;
    space.execute({ action: "move", sourceKey: `s:${fourth.session.id}`, targetKey: null, position: "inside", expectedRevision: space.read().revision });
    release();
    await pending;
    expect(space.read().nodes.find(node => node.entityId === fourth.session.id)?.parentKey).toBeNull();
    expect(space.read().nodes.find(node => node.entityId === fourth.session.id)?.manualPlacement).toBe(true);
    enabled = false;
    delayed = undefined;
    const fifth = create("여행 준비");
    await start(fifth);
    expect(space.read().nodes.find(node => node.entityId === fifth.session.id)?.parentKey).toBeNull();
  } finally { grouping.close(); server.stop(); rmSync(dir, { recursive: true, force: true }); }
});
