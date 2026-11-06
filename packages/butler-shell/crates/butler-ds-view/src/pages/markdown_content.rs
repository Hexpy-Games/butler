//! MarkdownContent.showcase.tsx (+ MarkdownLinkSample.tsx, MarkdownImageSample.tsx), and two native
//! checks of the engine: every GFM construct, and code in each grammar.
use butler_ds::tokens::Length;
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::markdown_content::{Density, MarkdownContent};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::card::{Card, CardPadding};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::icon_px;
use butler_ds::ui::layout::{Cross, Space, Stack};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};
use std::time::Duration;

use super::Story;
use super::inline_reference::favicon;
use crate::copy::Lang;

/// The streaming demo's cadence: a chunk of 14 characters every 90 ms. // DS: MarkdownContent.showcase.tsx:75
const CHUNK: usize = 14;
const TICK: Duration = Duration::from_millis(90);

const INLINE_IMAGE: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='400' viewBox='0 0 640 400'%3E%3Crect width='640' height='400' fill='%23e9eaec'/%3E%3Cpath d='m80 320 150-160 110 100 80-90 140 150H80Z' fill='%2371767d'/%3E%3C/svg%3E";

fn copy_labels(lang: Lang) -> (&'static str, &'static str) {
    lang.pick(("Copy code", "Copied"), ("코드 복사", "복사됨"))
}

fn document(lang: Lang) -> String {
    lang.pick(
        "# Project spec\n\nMarkdown keeps document rhythm inside the design system. Inline `project-ledger check` and [links](#spec)stay in the text flow.\n\n## Implementation\n\nSubsections keep a smaller, consistent section gap.\n\n- Readable list spacing\n- Clear item separation\n  - Nested items keep the same rhythm\n\n1. Plan the change\n2. Verify it\n\n> Quoted notes use a quiet rule and secondary text.\n",
        "# 프로젝트 명세\n\n마크다운은 디자인 시스템 안에서 문서 리듬을 지킵니다. 인라인 `project-ledger check` 과 [링크](#spec)는 문장 흐름 안에 있습니다.\n\n## 구현\n\n하위 절은 더 작고 일정한 간격을 씁니다.\n\n- 읽기 쉬운 목록 간격\n- 분명한 항목 구분\n  - 중첩 항목도 같은 리듬을 따릅니다\n\n1. 변경 계획하기\n2. 검증하기\n\n> 인용은 조용한 선과 보조 텍스트를 씁니다.\n",
    )
    .to_owned()
}

fn compact(lang: Lang) -> String {
    // The Document story without its headings but the h3, as the React compact story has.
    lang.pick(
        "Markdown keeps document rhythm inside the design system. Inline `project-ledger check` and [links](#spec)stay in the text flow.\n\n### Implementation\n\nSubsections keep a smaller, consistent section gap.\n\n- Readable list spacing\n- Clear item separation\n  - Nested items keep the same rhythm\n\n1. Plan the change\n2. Verify it\n\n> Quoted notes use a quiet rule and secondary text.\n",
        "마크다운은 디자인 시스템 안에서 문서 리듬을 지킵니다. 인라인 `project-ledger check` 과 [링크](#spec)는 문장 흐름 안에 있습니다.\n\n### 구현\n\n하위 절은 더 작고 일정한 간격을 씁니다.\n\n- 읽기 쉬운 목록 간격\n- 분명한 항목 구분\n  - 중첩 항목도 같은 리듬을 따릅니다\n\n1. 변경 계획하기\n2. 검증하기\n\n> 인용은 조용한 선과 보조 텍스트를 씁니다.\n",
    )
    .to_owned()
}

fn links(lang: Lang) -> &'static str {
    lang.pick(
        "I checked the release and the docs.\n\n- The fix landed in [PR #539: release republish](https://github.com/example-org/notes/pull/539); the tracking issue is https://github.com/example-org/notes/issues/512.\n- Background: the [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security) and [rel=noopener on MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/rel/noopener).\n- The raw report: https://reports.design-system.platform.example.com/teams/butler/inline-reference/2026/10/very-long-report-name?view=full&tab=links#section-4\n\n| Source | Link |\n| --- | --- |\n| Guide | [First run](https://docs.example.com/guide/first-run/) |\n| Mirror | https://mirror.example.org/butler |\n\n### Notes from [the changelog](https://docs.example.com/changelog)\n\nQuestions go to [support@example.com](mailto:support@example.com); see also the [notes below](#notes).",
        "릴리스와 문서를 확인했어요.\n\n- 수정은 [PR #539: 릴리스 재게시](https://github.com/example-org/notes/pull/539)에 들어갔고, 추적 이슈는 https://github.com/example-org/notes/issues/512 입니다.\n- 참고 자료: [Electron 보안 체크리스트](https://www.electronjs.org/docs/latest/tutorial/security)와 [MDN의 rel=noopener](https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/rel/noopener).\n- 원본 보고서: https://reports.design-system.platform.example.com/teams/butler/inline-reference/2026/10/very-long-report-name?view=full&tab=links#section-4\n\n| 출처 | 링크 |\n| --- | --- |\n| 안내서 | [처음 실행](https://docs.example.com/guide/first-run/) |\n| 미러 | https://mirror.example.org/butler |\n\n### [변경 기록](https://docs.example.com/changelog) 메모\n\n문의는 [support@example.com](mailto:support@example.com)로 보내고, [아래 메모](#notes)도 함께 보세요.",
    )
}

fn host_favicon(href: &str) -> Option<gpui::ImageSource> {
    let rest = href.split_once("://")?.1;
    favicon(rest.split(['/', '?', '#']).next()?)
}

/// Every GFM construct the engine handles, for the native check (no React counterpart).
const GFM: &str = "# Heading 1\n\n## Heading 2\n\n### Heading 3\n\n#### Heading 4\n\nA paragraph with **bold**, *italic*, ***both***, ~~strikethrough~~, ~single tildes stay~, `inline code`, a [titled link](https://example.com/page), a bare URL https://example.com/docs/page, a www.example.com address, an e-mail dev@example.com, and **bold.**word after punctuation.\nA soft break above, a hard break below.  \nAfter the hard break.\n\n- [x] A finished task\n- [ ] An open task\n- A bullet\n  - A nested bullet\n    - A third level\n\n1. First\n2. Second\n   1. Nested ordered\n\n> A quote\n>\n> > nested quote\n\n| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |\n| `code` | **bold** | [link](https://example.com) |\n\n---\n\n```\nA fence without a language\n```\n\n    An indented code block\n";

const CODE: [(&str, &str); 12] = [
    (
        "bash",
        "#!/usr/bin/env bash\nset -euo pipefail\nname=\"$1\" # first argument\necho \"hello ${name}\" | grep -c hello\n",
    ),
    (
        "css",
        ".card:hover > .title {\n  color: #3b6fd8;\n  margin: 4px 8px;\n  font: 600 14px/1.4 sans-serif; /* title */\n}\n",
    ),
    (
        "diff",
        "diff --git a/main.rs b/main.rs\n--- a/main.rs\n+++ b/main.rs\n@@ -1,3 +1,3 @@\n fn main() {\n-    println!(\"old\");\n+    println!(\"new\");\n }\n",
    ),
    (
        "go",
        "package main\n\nimport \"fmt\"\n\n// main prints a greeting.\nfunc main() {\n\tcount := 3\n\tfmt.Println(\"hello\", count)\n}\n",
    ),
    (
        "javascript",
        "import { check } from \"project-ledger\";\n\n// Fails when a spec drifts from its plan.\nconst result = await check({ strict: true });\nconsole.log(result.ok ? 1 : null);\n",
    ),
    (
        "json",
        "{\n  \"name\": \"butler\",\n  \"private\": true,\n  \"scripts\": { \"build\": \"vite build\" },\n  \"count\": 12,\n  \"nested\": [1, 2.5, null, false]\n}\n",
    ),
    (
        "markdown",
        "# Title\n\n- an item with **bold**\n> a quote\n\n[link](https://example.com)\n",
    ),
    (
        "python",
        "@dataclass\nclass Point:\n    x: int = 0\n\ndef norm(p: Point) -> float:\n    \"\"\"Length.\"\"\"\n    return (p.x ** 2) ** 0.5  # root\n",
    ),
    (
        "rust",
        "#[derive(Debug)]\nstruct Row<'a> {\n    name: &'a str,\n}\n\nfn main() {\n    let row = Row { name: \"x\" }; // a row\n    println!(\"{row:?} {}\", 42_u32);\n}\n",
    ),
    (
        "typescript",
        "interface User {\n  id: number;\n  name?: string;\n}\n\ntype Id = User[\"id\"];\n\nexport async function load(id: Id): Promise<User> {\n  return (await fetch(`/u/${id}`)).json() as Promise<User>;\n}\n",
    ),
    (
        "xml",
        "<?xml version=\"1.0\"?>\n<!-- a feed -->\n<feed xmlns=\"http://www.w3.org/2005/Atom\">\n  <title lang=\"en\">Notes</title>\n</feed>\n",
    ),
    (
        "yaml",
        "name: build\non:\n  push:\n    branches: [main]\njobs:\n  test:\n    steps:\n      - run: cargo test  # all\n        retries: 3\n",
    ),
];

fn fenced(lang: &str, code: &str) -> String {
    format!("**{lang}**\n\n```{lang}\n{code}```\n")
}

pub(super) fn stories() -> Vec<Story> {
    let story = |name, render| Story { name, render };
    vec![
        story("Document", |lang, _, _| {
            MarkdownContent::new("md-document", document(lang)).into_any_element()
        }),
        story("Links in a reply", |lang, _, _| {
            MarkdownContent::new("md-links", links(lang))
                .favicon(host_favicon)
                .into_any_element()
        }),
        story("Code frame with copy", code_frame),
        story("Table", table),
        story("Inline image", inline_image),
        story("Compact density", |lang, _, _| {
            Card::new("md-compact-card")
                .padding(CardPadding::Sm)
                .child(MarkdownContent::new("md-compact", compact(lang)).density(Density::Compact))
                .into_any_element()
        }),
        story("Reply captures", captures),
        story("Streaming reveal", streaming),
        story("GFM constructs (native check)", |_, _, _| {
            MarkdownContent::new("md-gfm", GFM).into_any_element()
        }),
        story("Code in every grammar (native check)", grammars),
    ]
}

fn code_frame(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let (copy, copied) = copy_labels(lang);
    let code = "```ts\nimport { check } from \"project-ledger\";\n\n// Fails when a spec drifts from its plan.\nconst result = await check({ strict: true });\n```\n";
    MarkdownContent::new("md-code", code)
        .copy_code(copy, copied)
        .into_any_element()
}

fn table(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let table = lang.pick(
        "### Verification matrix\n\n| Check | Command | Result |\n| --- | --- | --- |\n| Types | `bun run typecheck` | Passed |\n| Design lint | `bun run lint:design` | Passed |\n",
        "### 검증 표\n\n| 점검 | 명령 | 결과 |\n| --- | --- | --- |\n| 타입 | `bun run typecheck` | 통과 |\n| 디자인 린트 | `bun run lint:design` | 통과 |\n",
    );
    MarkdownContent::new("md-table", table).into_any_element()
}

fn inline_image(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let source = lang.pick(
        format!("An image smaller than the column keeps its natural size.\n\n![Settings screen at 375px](<{INLINE_IMAGE}>)\n"),
        format!("본문 폭보다 작은 이미지는 원래 크기로 보입니다.\n\n![375px 설정 화면](<{INLINE_IMAGE}>)\n"),
    );
    MarkdownContent::new("md-image", source).into_any_element()
}

fn grammars(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let source: String = CODE
        .iter()
        .map(|(lang, code)| fenced(lang, code))
        .collect::<Vec<_>>()
        .join("\n");
    MarkdownContent::new("md-grammars", source).into_any_element()
}

/// MessageMarkdown while streaming: chunks arrive every 90 ms and fade in place.
fn streaming(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let source = lang.pick(
        "Streaming text **fades in per chunk**: each appended chunk keeps its own span, so nothing moves while the answer grows. Settled messages render plain markdown.",
        "스트리밍 텍스트는 **조각마다 서서히 나타납니다**. 새 조각마다 자기 span을 유지하므로 답이 길어져도 아무것도 움직이지 않습니다. 끝난 메시지는 일반 마크다운으로 그립니다.",
    );
    let started = window.use_keyed_state("md-stream-start", cx, |_, cx| {
        cx.background_executor().now()
    });
    let elapsed = cx
        .background_executor()
        .now()
        .saturating_duration_since(*started.read(cx));
    let chars: Vec<(usize, char)> = source.char_indices().collect();
    let shown = ((elapsed.as_millis() / TICK.as_millis()) as usize * CHUNK).min(chars.len());
    let done = shown >= chars.len();
    if !done {
        window.request_animation_frame();
    }
    let end = chars.get(shown).map_or(source.len(), |(at, _)| *at);
    let replay = Button::new("md-stream-replay")
        .size(Size::Sm)
        .variant(Variant::Outline)
        .text(lang.pick("Replay stream", "스트림 다시 재생"))
        .on_click(move |_, _, cx| {
            started.update(cx, |at, cx| {
                *at = cx.background_executor().now();
                cx.notify();
            });
        });
    Stack::new()
        .gap(Space::Sm)
        .child(super::probe(format!("md-streaming-{}", !done)))
        .child(MarkdownContent::new("md-stream", source[..end].to_owned()).streaming(!done))
        .child(replay)
        .into_any_element()
}

/// A data-URI SVG picture of `width` by `height` with the given shapes.
fn picture(width: u32, height: u32, shapes: &str) -> String {
    let body = format!(
        "<svg xmlns='http://www.w3.org/2000/svg' width='{width}' height='{height}' viewBox='0 0 {width} {height}'>{shapes}</svg>"
    )
    .replace('<', "%3C")
    .replace('>', "%3E")
    .replace('#', "%23");
    format!("data:image/svg+xml,{body}")
}

/// MarkdownImageSample.tsx: reply captures, a capture taller than the column, and a badge in its
/// sentence. The captures sit in an `ArtifactPreviewImage` with Open and Save under them in React;
/// that block is P2-S5's, so a capture here is the engine's image with the two buttons under it.
fn captures(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let (route, open, save, page, icon, passed) = lang.pick(
        (
            "Here is the route: Ferry Building → Golden Gate Bridge → Sausalito, about 24 min (12.2 mi) via US-101.",
            "Open",
            "Save",
            "The full page capture is tall, so it is shown at a bounded height.",
            "Small images keep their own size: the build",
            "badge sits in the sentence.",
        ),
        (
            "경로를 짰습니다. 페리 빌딩 → 금문교 → 소살리토, US-101 경유 약 24분(12.2마일)입니다.",
            "열기",
            "저장하기",
            "페이지 전체 캡처는 세로로 길어서 높이를 제한해 보여 줍니다.",
            "작은 이미지는 원래 크기를 지킵니다. 빌드",
            "배지가 문장 안에 놓입니다.",
        ),
    );
    let route_capture = picture(
        1600,
        1000,
        "<rect width='1600' height='1000' fill='#a9d3e6'/><path d='M520 0h560c-40 120 30 260-20 380s-150 170-110 300 160 220 140 320H520Z' fill='#e8eadf'/><path d='M640 120c60 40 90 120 140 170s40 140 90 210 60 160 140 230 200 60 260 120' fill='none' stroke='#4b3fd8' stroke-width='12' stroke-linecap='round'/><rect width='480' height='1000' fill='#ffffff'/><rect x='40' y='60' width='400' height='44' rx='10' fill='#f1f3f4'/><rect x='40' y='300' width='400' height='120' rx='12' fill='#e8f0fe'/>",
    );
    let page_capture = picture(
        900,
        2700,
        "<rect width='900' height='2700' fill='#f6f7f9'/><rect width='900' height='120' fill='#202124'/><rect x='60' y='200' width='780' height='140' rx='16' fill='#dfe7f5'/><rect x='60' y='380' width='780' height='140' rx='16' fill='#ffffff'/>",
    );
    let badge = picture(
        88,
        20,
        "<rect width='88' height='20' rx='4' fill='#2da44e'/><rect x='8' y='7' width='72' height='6' rx='3' fill='#ffffff'/>",
    );
    let ds = Ds::get(cx);
    let buttons = |id: &str| {
        butler_ds::ui::button::container(Size::Xs)
            .child(
                Button::new(format!("{id}-open"))
                    .size(Size::Xs)
                    .variant(Variant::Inline)
                    .icon_start(icon_px(Icon::Expand, ds.len(Length::IconSizeSm)))
                    .text(open),
            )
            .child(
                Button::new(format!("{id}-save"))
                    .size(Size::Xs)
                    .variant(Variant::Inline)
                    .icon_start(icon_px(Icon::Save, ds.len(Length::IconSizeSm)))
                    .text(save),
            )
    };
    let capture = |id: &str, source: String| {
        Stack::new()
            .gap(Space::Xs)
            .cross(Cross::Start)
            .child(MarkdownContent::new(format!("md-capture-{id}"), source))
            .child(buttons(id))
    };
    Stack::new()
        .gap(Space::Md)
        .child(MarkdownContent::new("md-capture-route-text", route))
        .child(capture("route", format!("![](<{route_capture}>)")))
        .child(MarkdownContent::new("md-capture-page-text", page))
        .child(capture("page", format!("![](<{page_capture}>)")))
        .child(MarkdownContent::new(
            "md-capture-badge",
            format!("{icon} ![passing](<{badge}>) {passed}"),
        ))
        .into_any_element()
}
