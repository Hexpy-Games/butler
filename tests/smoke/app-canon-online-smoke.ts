import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Locator, Page } from "playwright";
import type { CanonActivity, CanonOnlineAction, CanonOnlineLink, CanonOverview, CanonSpaceMembers, EpicDetail } from "../../packages/butler-protocol/src/canon-contracts.ts";
import { closeCanonAside } from "../support/canon-board-aside.ts";
import { openCanonBoard, seedCanonBoard } from "../support/canon-board-scenarios.ts";
import { createNativeAppServer, type NativeAppServerHandle } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";

const shots = process.env.BUTLER_SMOKE_SHOTS;
const lock = "연결이 끊겨 고칠 수 없습니다";
const viewerLock = "보기 권한만 있습니다";
const share = "온라인 공유";
const joinLabel = "초대 코드로 참여";
const owner = { account_id: "acc_me", email: "a@example.com", role: "owner" as const, added_at: "" };
const editor = { account_id: "acc_editor", email: "b@example.com", role: "editor" as const, added_at: "" };
const viewer = { account_id: "acc_viewer", email: "d@example.com", role: "viewer" as const, added_at: "" };

async function installGatewayRoutes(page: Page, server: NativeAppServerHandle, projectId: string, epicId: string) {
  const requests: (CanonOnlineAction | { action: "create"; source: string } | { action: "delete"; path: string })[] = [];
  const members: CanonSpaceMembers = {
    members: [owner, editor, viewer], invites: [{ id: "pending", email: "e@example.com", role: "viewer", expires_at: "" }],
  };
  const linked: CanonOnlineLink = { project_id: projectId, space_id: "space", role: "owner", state: "linked", connection: "connected", pending: 0 };
  const fake = { signedIn: !shots, links: [] as CanonOnlineLink[], rejectJoin: undefined as Promise<void> | undefined };
  const conflict: CanonActivity = {
    seq: 1000, entity_id: epicId, kind: "edited", summary: "", at: Date.now(),
    actor: { person: editor.email, via: "sync" },
    body: JSON.stringify({ conflict: true, fields: { title: "tA", canon_status: "done" } }),
  };
  await page.route(`${server.url}**`, async route => {
    const { pathname, search } = new URL(route.request().url());
    const method = route.request().method();
    const headers = { ...route.request().headers(), ...server.authHeaders };
    const respond = (data: unknown) => route.fulfill({ json: { protocol_version: "butler.app.v1", data } });
    if (pathname === "/setup/butler-account") {
      return respond(fake.signedIn ? { signed_in: true, account: { id: owner.account_id } } : { signed_in: false });
    }
    if (pathname === "/setup/canon-online") {
      if (method === "GET") return respond({ links: fake.links });
      const action = route.request().postDataJSON() as CanonOnlineAction;
      requests.push(action);
      switch (action.action) {
        case "link":
          fake.links = [{ ...linked }];
          return respond({ link: fake.links[0] });
        case "members": return respond(members);
        case "invite": return respond({ id: "invite" });
        case "revoke_invite":
          members.invites = members.invites.filter(invite => invite.id !== action.invite_id);
          return respond({ revoked: true });
        case "set_role":
          members.members = members.members.map(member => member.account_id === action.account_id ? { ...member, role: action.role } : member);
          return respond({});
        case "remove_member":
          members.members = members.members.filter(member => member.account_id !== action.account_id);
          return respond({ removed: true });
        case "leave":
          fake.links = [];
          return respond({ left: true });
        case "join":
          if (fake.rejectJoin) {
            await fake.rejectJoin;
            return route.fulfill({ status: 400, json: { error: { code: "invalid_invite" } } });
          }
          fake.links.push({ ...linked, project_id: action.project_id, role: "viewer" });
          return respond({ link: fake.links.at(-1) });
        case "spaces":
          return respond({ spaces: fake.links.map(link => ({ project_id: link.project_id, name: "온라인 공간" })) });
        case "unlink":
          fake.links = [];
          return respond({ unlinked: true });
      }
    }
    if (pathname === "/projects" && method === "POST") {
      requests.push({ action: "create", source: route.request().postDataJSON().source });
    }
    if (pathname.startsWith("/projects/") && method === "DELETE") {
      requests.push({ action: "delete", path: pathname + search });
    }
    if (pathname === `/canon/epics/${epicId}` && method === "GET") {
      const response = await route.fetch({ headers });
      const payload = await response.json() as { data: EpicDetail };
      payload.data.activity = [conflict, ...(payload.data.activity ?? [])];
      return route.fulfill({ response, json: payload });
    }
    await route.continue({ headers });
  });
  return { fake, linked, members, requests };
}

async function capture(page: Page, name: string, regions: Locator[], aboveComposer = false, pad = 16) {
  if (!shots) return;
  const parentBoxes = await Promise.all(regions.map(region => region.evaluate(async node => {
    const animations = node.getAnimations({ subtree: true });
    const dialog = node.closest('[role="dialog"], [role="alertdialog"]');
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
      animations.push(...ancestor.getAnimations({ subtree: ancestor === dialog }));
    }
    await Promise.all(animations
      .filter(animation => animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished));
    if (dialog?.getAttribute("role") !== "alertdialog") return null;
    const openDialog = '[role="dialog"][data-state="open"]';
    const parent = dialog.parentElement?.closest(openDialog) ?? Array.from(document.querySelectorAll(openDialog)).at(-1);
    if (!parent) return null;
    const { x, y, width, height } = parent.getBoundingClientRect();
    return { x, y, width, height };
  })));
  const boxes = await Promise.all(regions.map(region => region.boundingBox()));
  assert(boxes.every(box => box !== null), name);
  const parentBox = parentBoxes.find(box => box !== null);
  const framing = parentBox ? [parentBox] : boxes;
  const x = Math.max(0, Math.floor(Math.min(...framing.map(box => box!.x))) - pad);
  const y = Math.max(0, Math.floor(Math.min(...framing.map(box => box!.y))) - pad);
  const right = Math.min(page.viewportSize()!.width, Math.ceil(Math.max(...framing.map(box => box!.x + box!.width))) + pad);
  const composerTop = aboveComposer ? await page.locator('[data-test-class="project-dashboard-view"] [data-test-class="composer-card"]')
    .evaluate(composer => Math.floor(composer.getBoundingClientRect().top)) : page.viewportSize()!.height;
  const bottom = Math.min(composerTop, page.viewportSize()!.height, Math.ceil(Math.max(...framing.map(box => box!.y + box!.height))) + pad);
  await page.screenshot({ path: join(shots, `${name}.png`), animations: "disabled", clip: { x, y, width: right - x, height: bottom - y } });
}

async function verifyOnline(page: Page, server: NativeAppServerHandle, projectId: string, epicId: string, cell: string) {
  const { fake, linked, members, requests } = await installGatewayRoutes(page, server, projectId, epicId);
  await page.goto(server.url);
  await openCanonBoard(page);
  const board = page.locator('[data-test-class="canon-board"]');
  const dialog = page.getByRole("dialog", { name: share, exact: true });
  const menu = page.getByRole("menu");
  const dashboardMenu = page.getByRole("button", { name: "프로젝트 메뉴", exact: true });
  const shareItem = menu.getByRole("menuitem", { name: share, exact: true });
  const confirm = page.getByRole("alertdialog");
  const shot = (name: string, ...regions: Locator[]) => capture(page, `${cell}-${name}`, regions);
  const mobile = page.viewportSize()!.width === 390;
  await dashboardMenu.click();
  await shareItem.waitFor();
  await shot("dashboard-menu", menu);
  await shareItem.click();
  if (shots) {
    await dialog.getByText("버틀러 계정에 로그인해야 합니다", { exact: true }).waitFor();
    await shot("signed-out", dialog);
    await dialog.getByRole("button", { name: "닫기", exact: true }).click();
    fake.signedIn = true;
    await dashboardMenu.click();
    await shareItem.click();
  }
  const toggle = dialog.getByRole("switch", { name: "온라인 프로젝트" });
  await toggle.waitFor();
  await shot("local", dialog);
  await toggle.click();
  const online = board.getByRole("button", { name: "온라인", exact: true });
  await dialog.getByText(owner.email, { exact: true }).waitFor();
  assert.deepEqual(requests.find(request => request.action === "link"), { action: "link", project_id: projectId, name: "캐논 보드" });
  if (shots) await page.getByText("온라인 프로젝트로 바꿨습니다", { exact: true }).waitFor({ state: "hidden" });
  await shot("owner", dialog);

  const email = dialog.getByRole("textbox", { name: "이메일", exact: true });
  const role = dialog.getByRole("combobox", { name: "역할", exact: true });
  const invite = dialog.getByRole("button", { name: "초대", exact: true });
  if (shots && page.viewportSize()!.width === 390) {
    await invite.evaluate(button => button.scrollIntoView({ block: "center" }));
    await shot("invite-wrap", email, role, invite);
    await page.setViewportSize({ width: 375, height: 844 });
    const [emailBox, roleBox, inviteBox] = await Promise.all([email.boundingBox(), role.boundingBox(), invite.boundingBox()]);
    assert(emailBox && roleBox && inviteBox && emailBox.y + emailBox.height <= roleBox.y && emailBox.y + emailBox.height <= inviteBox.y);
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await email.fill("c@example.com");
  await role.selectOption("viewer");
  await invite.click();
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[aria-label="이메일"]')?.value === "");
  assert.deepEqual(requests.find(request => request.action === "invite"), { action: "invite", project_id: projectId, email: "c@example.com", role: "viewer" });
  await dialog.getByRole("button", { name: "초대 취소", exact: true }).click();
  await dialog.getByText("e@example.com", { exact: true }).waitFor({ state: "hidden" });
  assert.deepEqual(requests.find(request => request.action === "revoke_invite"), { action: "revoke_invite", project_id: projectId, invite_id: "pending" });
  const roleSet = page.waitForResponse(response => response.url().endsWith("/setup/canon-online") && response.request().method() === "POST");
  await dialog.getByRole("combobox", { name: `${editor.email} 역할`, exact: true }).selectOption("viewer");
  await roleSet;
  assert.deepEqual(requests.find(request => request.action === "set_role"), { action: "set_role", project_id: projectId, account_id: editor.account_id, role: "viewer" });
  await dialog.getByRole("button", { name: "내보내기", exact: true }).first().click();
  await confirm.getByRole("button", { name: "내보내기", exact: true }).waitFor();
  await shot("confirm-remove", confirm);
  await confirm.getByRole("button", { name: "내보내기", exact: true }).click();
  await dialog.getByText(editor.email, { exact: true }).waitFor({ state: "hidden" });
  assert.deepEqual(requests.find(request => request.action === "remove_member"), { action: "remove_member", project_id: projectId, account_id: editor.account_id });
  if (shots) {
    await toggle.click();
    await confirm.getByRole("button", { name: "끄기", exact: true }).waitFor();
    await shot("confirm-turn-off", confirm);
    await confirm.getByRole("button", { name: "취소", exact: true }).click();
  }
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await online.waitFor();

  const newEpic = board.getByRole("button", { name: "새 과제", exact: true }).first();
  const header = newEpic.locator('xpath=ancestor::*[@data-slot="button-container"][1]');
  await captureStatus(page, board, header, `${cell}-connected`, "온라인");
  if (shots) {
    fake.links = [{ ...linked, pending: 3 }];
    await captureStatus(page, board, header, `${cell}-connected-pending`, "온라인 · 보낼 변경 3건");
  }
  fake.links = [{ ...linked, connection: "offline", pending: 3 }];
  const offline = board.getByRole("button", { name: "오프라인 · 보낼 변경 3건", exact: true });
  await offline.getByText("3", { exact: true }).waitFor();
  await captureStatus(page, board, header, `${cell}-offline`, "오프라인 · 보낼 변경 3건");
  fake.links = [{ ...linked, connection: "error" }];
  await captureStatus(page, board, header, `${cell}-error`, "동기화 오류");
  fake.links = [{ ...linked, state: "detached", connection: "offline" }];
  await captureStatus(page, board, header, `${cell}-detached`, "연결 끊김");
  assert(await newEpic.isDisabled());
  if (!mobile) {
    const backlogGroup = page.locator(`[data-tree-item="p:${projectId}"] [data-canon-group="backlog"]`);
    const sidebarNew = backlogGroup.getByRole("button", { name: "백로그에 새 과제", exact: true });
    await sidebarNew.waitFor();
    assert(await sidebarNew.isDisabled());
  }
  await newEpic.hover();
  const tooltip = page.getByRole("tooltip", { name: lock, exact: true });
  await tooltip.waitFor();
  await capture(page, `${cell}-locked-board`, [board, tooltip], mobile);
  await board.getByRole("button", { name: "연결 끊김", exact: true }).click();
  await dialog.getByText("온라인 공간과 연결이 끊겼습니다", { exact: true }).waitFor();
  await shot("detached-dialog", dialog);
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();

  const epic = board.locator(`[data-kanban-item="${epicId}"]`).getByRole("button");
  const detail = page.locator('[data-test-class="canon-epic-detail"]');
  await epic.click();
  assert(await detail.getByRole("combobox", { name: "상태", exact: true }).isDisabled());
  await closeCanonAside(page);

  fake.links = [{ ...linked, role: "viewer" }];
  await online.waitFor();
  await epic.click();
  const activity = detail.locator('[data-test-class="canon-activity"]');
  const title = detail.getByRole("button", { name: "제목 수정", exact: true });
  await detail.waitFor();
  await title.hover();
  const reason = page.getByRole("tooltip", { name: viewerLock, exact: true });
  await reason.waitFor();
  assert.equal(await title.locator("svg").count(), 0, "No edit pencil on a locked epic");
  await capture(page, `${cell}-viewer-epic-tooltip`, [title, reason], mobile, 4);
  await page.mouse.move(0, 0);
  await reason.waitFor({ state: "hidden" });
  await capture(page, `${cell}-viewer-epic`, [detail], mobile);
  for (const line of ["다른 사람이 먼저 고쳤습니다", "제목: tA", "상태: 완료"]) await activity.getByText(line).waitFor();
  if (shots) {
    await activity.scrollIntoViewIfNeeded();
    await shot("activity-conflict", activity);
  }
  await closeCanonAside(page);

  members.members = [{ ...owner, account_id: "acc_owner" }, { ...editor, account_id: owner.account_id }, viewer];
  fake.links = [{ ...linked, role: "editor" }];
  await page.waitForResponse(response => response.url().endsWith("/setup/canon-online") && response.request().method() === "GET");
  await online.click();
  const leave = dialog.getByRole("button", { name: "나가기", exact: true });
  await dialog.getByText(owner.email, { exact: true }).waitFor();
  assert.equal(await email.count(), 0);
  await shot("editor", dialog);
  await leave.click();
  await confirm.getByRole("button", { name: "나가기", exact: true }).waitFor();
  await shot("confirm-leave", confirm);
  await confirm.getByRole("button", { name: "나가기", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(requests.find(request => request.action === "leave"), { action: "leave", project_id: projectId });
  return { fake, requests };
}

async function captureStatus(page: Page, board: Locator, header: Locator, file: string, label: string) {
  const icon = board.getByRole("button", { name: label, exact: true });
  await icon.waitFor();
  if (!shots) return;
  await icon.hover();
  const tooltip = page.getByRole("tooltip", { name: label, exact: true });
  await tooltip.waitFor();
  await capture(page, file, [header, tooltip]);
}

async function verifyJoin(page: Page, cell: string, { fake, requests }: Awaited<ReturnType<typeof verifyOnline>>) {
  const sidebar = page.getByRole("button", { name: "사이드바 보기", exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.getByRole("button", { name: "스페이스 메뉴", exact: true }).click();
  const menu = page.getByRole("menu");
  const item = menu.getByRole("menuitem", { name: joinLabel, exact: true });
  await item.waitFor();
  await capture(page, `${cell}-space-menu`, [menu]);
  await item.click();
  const dialog = page.getByRole("dialog", { name: joinLabel, exact: true });
  const input = dialog.getByRole("textbox", { name: "초대 코드", exact: true });
  const submit = dialog.getByRole("button", { name: "참여", exact: true });
  await input.waitFor();
  await capture(page, `${cell}-join-empty`, [dialog]);
  const failedStart = requests.length;
  const { promise, resolve: release } = Promise.withResolvers<void>();
  fake.rejectJoin = promise;
  try {
    await input.fill("invalid");
    await submit.click();
    if (shots) {
      await dialog.locator('form[aria-busy="true"]').waitFor();
      await capture(page, `${cell}-join-busy`, [dialog]);
    }
  } finally {
    release();
  }
  await dialog.getByText("참여하지 못했습니다. 코드를 확인해 주세요.", { exact: true }).waitFor();
  const failedRequests = requests.slice(failedStart);
  const failedJoin = failedRequests[1];
  assert(failedJoin?.action === "join");
  assert.deepEqual(failedRequests[2], { action: "delete", path: `/projects/${encodeURIComponent(failedJoin.project_id)}?permanent=true` });
  await capture(page, `${cell}-join-error`, [dialog]);
  fake.rejectJoin = undefined;
  const start = requests.length;
  await input.fill("bci_x");
  await submit.click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("tab", { name: "보드", selected: true }).waitFor();
  const entry = requests.slice(start);
  assert(entry[1]?.action === "join");
  assert.deepEqual(entry.slice(0, 3), [
    { action: "create", source: "scratch" },
    { action: "join", project_id: entry[1].project_id, token: "bci_x" },
    { action: "spaces" },
  ]);
}

if (shots) mkdirSync(shots, { recursive: true });
const server = await createNativeAppServer({ uiRoot: resolve("packages/butler-app/client/ui/dist") });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
try {
  const { projectId, planId } = await seedCanonBoard(server);
  const canon = await server.api<CanonOverview>(`/projects/${projectId}/canon`);
  const epicId = canon.plans.find(plan => plan.id === planId)!.works.find(epic => epic.canon_status === "planned")!.id;
  browser = await launchSmokeBrowser();
  for (const width of [1440, 390]) {
    for (const theme of ["light", "dark"] as const) {
      await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme }) });
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, deviceScaleFactor: 2, colorScheme: theme });
      try {
        await server.signIn(context);
        const page = await context.newPage();
        const cell = `${width}-${theme}`;
        const state = await verifyOnline(page, server, projectId, epicId, cell);
        await verifyJoin(page, cell, state);
        console.log(`Canon online smoke passed (${cell})`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  try { await browser?.close(); } finally { await server.stop(); }
}
