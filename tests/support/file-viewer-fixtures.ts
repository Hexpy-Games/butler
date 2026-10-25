import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import type { SessionArtifactSummary, SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import { allowStubImages, drawPhoto, sendWithFiles, uploadFixture, type FixtureFile, type StoredFile } from "./attachment-fixtures.ts";
import type { NativeAppServerHandle } from "./native-app-server.ts";

export const FILES = { markdown: "릴리스-노트.md", code: "ime-guard.ts", image: "단축키-충돌.jpg" } as const;
export const IMAGE_SIZE = { width: 480, height: 300 };

const MARKDOWN = `# 릴리스 노트

## 새 기능

- **세션 정보**: 답을 기다리는 요청, 과제, 결과물, 컨텍스트를 대화 옆에 모아 보여 줍니다.
- **파일 보기**: 결과물과 첨부를 대화 옆 오른쪽 칸에서 읽습니다.

## 고친 점

1. 한글 조합 중에 ⌘K를 눌러도 글자가 사라지지 않습니다.
2. 검색 결과가 최근 수정순으로 정렬됩니다.

> 컨텍스트가 매우 길면 자동 압축 직후 첫 답변이 조금 늦을 수 있습니다.

| 항목 | 이전 | 지금 |
| --- | --- | --- |
| 세션 정보 | 인스펙터 탭 | 대화 여백 |
| 파일 | 272px 칸 | 오른쪽 칸 |

${Array.from({ length: 12 }, (_, index) => `${index + 3}. 변경 사항 ${index + 1}: 긴 문서도 하나의 스크롤로 읽습니다.`).join("\n")}
`;

const CODE = `// Global shortcuts wait while an IME is composing: Cmd+K mid-composition must not
// open the palette or drop the pending syllable.
export function shouldHandleShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
}
`;

/** Uploads the three files into a new session through the native App and sends them in one stub turn. */
export async function seedFileSession(server: NativeAppServerHandle, page: Page, title: string) {
  const config = JSON.parse(readFileSync(join(server.butlerData, "butler.config.json"), "utf8"));
  const local = config.models?.local?.[0];
  if (local) await allowStubImages(server, local.server_url);
  const { session } = await server.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title }) });
  const fixtures: FixtureFile[] = [
    { name: FILES.markdown, mimeType: "text/markdown", buffer: Buffer.from(MARKDOWN) },
    { name: FILES.code, mimeType: "text/plain", buffer: Buffer.from(CODE) },
    await drawPhoto(page, FILES.image, IMAGE_SIZE.width, IMAGE_SIZE.height, 210),
  ];
  const stored: StoredFile[] = [];
  for (const fixture of fixtures) stored.push(await uploadFixture(server, session.id, fixture));
  await sendWithFiles(server, session.id, "릴리스 노트와 코드를 검토해 줘", stored);
  return session.id;
}

/**
 * The stored session with Butler's results: the markdown and code files as 결과물, and an answer that shows the
 * picture inline (its 열기 button). Files, URLs and signatures are the native App's own.
 */
export function withResults(view: SessionView): SessionView {
  const user = view.messages.find((message) => message.attachments?.length);
  assert(user, "the stub turn stored the uploaded files");
  const files = new Map(user.attachments!.map((file) => [file.safe_name, file]));
  const artifact = (name: string, kind: string, deliverable: boolean): SessionArtifactSummary => {
    const file = files.get(name);
    assert(file, `${name} was stored`);
    return { id: `result-${file.file_id}`, session_id: view.session_id, message_id: "file-viewer-answer", file_id: file.file_id, title: name, kind,
      safe_path_label: name, url: file.url, signed_url: file.signed_url, size_bytes: file.size_bytes, created_at: file.created_at, deliverable };
  };
  // The picture is shown in the answer, not delivered: it has no 서랍 entry.
  const image = artifact(FILES.image, "image", false);
  const answer = { ...user, id: "file-viewer-answer", role: "assistant" as const, attachments: [], artifacts: [image],
    text: `검토한 화면입니다.\n\n![단축키 충돌](${image.url})`, cursor: (user.cursor ?? 0) + 100 };
  return { ...view, artifacts: [artifact(FILES.markdown, "document", true), artifact(FILES.code, "code", true)], messages: [...view.messages, answer] };
}

/** Geometry of the docked viewer: no sideways overflow anywhere, and the reading page within 760px and 48px in. */
export async function viewerGeometry(viewer: Locator) {
  return viewer.evaluate((root) => {
    const page = root.querySelector('[data-test-class="file-viewer-page"]')!.getBoundingClientRect();
    const content = root.querySelector('[data-test-class="artifact-viewer"]')!.getBoundingClientRect();
    const scroll = root.querySelector('[data-test-class="file-viewer-scroll"]')!;
    const card = root.getBoundingClientRect();
    return {
      pageWidth: page.width,
      insetStart: Math.round(content.left - card.left),
      insetEnd: Math.round(card.right - content.right),
      // What the user can scroll sideways: the pane's scroller and the window. The card clips its own edges.
      overflow: Math.max(scroll.scrollWidth - scroll.clientWidth, document.documentElement.scrollWidth - innerWidth),
      contentPastCard: Math.max(0, Math.round(content.right - card.right)),
      scrollLaneBleed: Math.round(scroll.parentElement!.getBoundingClientRect().right - card.right),
      paneScrolls: scroll.scrollHeight > scroll.clientHeight,
      innerScrolls: [...root.querySelectorAll('[data-test-class="artifact-viewer"] *')]
        .filter((node) => ["auto", "scroll"].includes(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight).length,
    };
  });
}

/**
 * The header keeps one row: name, actions and close share a line, the name truncates, and below 480px the actions
 * are icon buttons with accessible names.
 */
export async function headerLayout(viewer: Locator) {
  return viewer.locator('[data-test-class="file-viewer-header"]').evaluate((header) => {
    const title = header.querySelector("h2")!;
    const center = (node: Element) => { const box = node.getBoundingClientRect(); return box.top + box.height / 2; };
    const buttons = [...header.querySelectorAll("button, a")];
    const titleCenter = center(title);
    const card = header.getBoundingClientRect();
    return {
      compact: header.hasAttribute("data-compact"),
      rows: new Set(buttons.map((button) => Math.round((center(button) - titleCenter) / 8))).size,
      offRow: buttons.filter((button) => Math.abs(center(button) - titleCenter) > 14).map((button) => button.getAttribute("aria-label")),
      outside: buttons.filter((button) => button.getBoundingClientRect().right > card.right + 0.5).length,
      lastIsClose: buttons.at(-1)?.getAttribute("data-test-class") === "file-viewer-close",
      unnamed: buttons.filter((button) => !(button.getAttribute("aria-label") || button.textContent?.trim())).length,
      iconOnly: buttons.filter((button) => !button.textContent?.trim()).length,
      labels: buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim()),
      truncates: getComputedStyle(title).textOverflow === "ellipsis" || title.scrollWidth <= title.clientWidth,
    };
  });
}
