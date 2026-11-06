//! InlineReference.showcase.tsx (the state-matrix stories of the viewer are not part of it).
//! Sentences are `InlineFlow`s: gpui lays no element inside a text run.
use std::sync::Arc;

use butler_ds::ui::Icon;
use butler_ds::ui::context::Ds;
use butler_ds::ui::inline_reference::{InlineFlow, InlineReference};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::Role;
use gpui::{
    AnyElement, App, FontWeight, Image, ImageFormat, ImageSource, IntoElement as _,
    ParentElement as _, Styled as _, Window, div,
};

use super::Story;
use crate::copy::Lang;

struct Copy {
    before: &'static str,
    conversation: &'static str,
    after: &'static str,
    document: &'static str,
    end: &'static str,
    gone: &'static str,
    removed: &'static str,
    tail: &'static str,
    ext_before: &'static str,
    pr: &'static str,
    ext_mid: &'static str,
    ext_and: &'static str,
    guide: &'static str,
    ext_end: &'static str,
    long_before: &'static str,
    long_title: &'static str,
    long_mid: &'static str,
    heading: &'static str,
    changelog: &'static str,
    fallback_before: &'static str,
    broken: &'static str,
    fallback_end: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            before: "Continue from",
            conversation: "Insurance coverage comparison",
            after: "and check",
            document: "Q3 planning notes",
            end: ".",
            gone: "An earlier reference to",
            removed: "Deleted draft",
            tail: "stays readable after it is removed.",
            ext_before: "The fix is in",
            pr: "PR #539: release republish",
            ext_mid: ", tracked at",
            ext_and: "; see the",
            guide: "first-run guide",
            ext_end: ".",
            long_before: "Background reading:",
            long_title: "Hardening a desktop app that opens links from untrusted model output",
            long_mid: "and the raw report at",
            heading: "Notes from",
            changelog: "the changelog",
            fallback_before: "No favicon yet, or none at all:",
            broken: "MDN on rel=noopener",
            fallback_end: "keep the globe.",
        },
        Copy {
            before: "이전",
            conversation: "보험 보장 비교",
            after: "내용과",
            document: "3분기 계획 메모",
            end: "를 참고해 주세요.",
            gone: "삭제된",
            removed: "초안 문서",
            tail: "도 기록에는 흐리게 남습니다.",
            ext_before: "수정은",
            pr: "PR #539: 릴리스 재게시",
            ext_mid: "에 들어갔고, 추적은",
            ext_and: "에서 합니다.",
            guide: "처음 실행 안내서",
            ext_end: "도 참고하세요.",
            long_before: "참고 자료:",
            long_title: "신뢰할 수 없는 모델 출력의 링크를 여는 데스크톱 앱 보안 강화하기",
            long_mid: "그리고 원본 보고서",
            heading: "메모 출처:",
            changelog: "변경 기록",
            fallback_before: "파비콘이 아직 없거나 아예 없으면",
            broken: "MDN의 rel=noopener",
            fallback_end: "처럼 지구본이 남습니다.",
        },
    )
}

const PR: &str = "https://github.com/example-org/notes/pull/539";
const ISSUE: &str = "https://github.com/example-org/notes/issues/512";
const GUIDE: &str = "https://docs.example.com/guide/first-run/";
const LONG: &str = "https://reports.design-system.platform.example.com/teams/butler/inline-reference/2026/10/very-long-report-name?view=full#section-4";
const MDN: &str = "https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/rel/noopener";

fn svg(body: &str, view_box: &str) -> ImageSource {
    let text =
        format!("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"{view_box}\">{body}</svg>");
    ImageSource::Image(Arc::new(Image::from_bytes(
        ImageFormat::Svg,
        text.into_bytes(),
    )))
}

/// sampleFavicons.ts: a dark glyph, a coloured mark, a wide mark and a broken image.
fn favicon(host: &str) -> Option<ImageSource> {
    match host {
        "github.com" => Some(svg(
            "<circle cx=\"16\" cy=\"16\" r=\"15\" fill=\"#1f2328\"/><circle cx=\"16\" cy=\"14\" r=\"6\" fill=\"#fff\"/><rect x=\"13\" y=\"19\" width=\"6\" height=\"9\" rx=\"2\" fill=\"#fff\"/>",
            "0 0 32 32",
        )),
        "www.electronjs.org" => Some(svg(
            "<circle cx=\"16\" cy=\"16\" r=\"13\" fill=\"none\" stroke=\"#2f9fb5\" stroke-width=\"4\"/><circle cx=\"16\" cy=\"16\" r=\"4\" fill=\"#2f9fb5\"/>",
            "0 0 32 32",
        )),
        "docs.example.com" => Some(svg(
            "<rect x=\"1\" y=\"9\" width=\"46\" height=\"14\" rx=\"7\" fill=\"#e8743b\"/><circle cx=\"12\" cy=\"16\" r=\"4\" fill=\"#fff\"/>",
            "0 0 48 32",
        )),
        "developer.mozilla.org" => Some(ImageSource::Image(Arc::new(Image::from_bytes(
            ImageFormat::Png,
            b"AAAA".to_vec(),
        )))),
        _ => None,
    }
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "In running text",
            render: running,
        },
        Story {
            name: "External links",
            render: external,
        },
        Story {
            name: "Long titles and URLs wrap",
            render: long,
        },
        Story {
            name: "Favicon fallback",
            render: fallback,
        },
        Story {
            name: "Unavailable",
            render: unavailable,
        },
    ]
}

fn ext(id: &str, href: &'static str, host: &str) -> InlineReference {
    let reference = InlineReference::external(id.to_owned(), href);
    match favicon(host) {
        Some(source) => reference.favicon(source),
        None => reference,
    }
}

/// `Typo.Body as="p"`: a block of body text.
fn paragraph(flow: InlineFlow, cx: &App) -> AnyElement {
    block(Role::Body, flow, cx)
}

fn block(role: Role, flow: InlineFlow, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let mut el = div().w_full().font_family(ds.body_font().clone());
    if let Some(tokens) = role.tokens() {
        el = el
            .text_size(ds.len(tokens.size))
            .line_height(ds.len(tokens.line_height))
            .font_weight(FontWeight(ds.number(tokens.weight)));
    }
    el.child(flow).into_any_element()
}

fn running(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let flow = InlineFlow::new()
        .text(format!("{} ", c.before))
        .reference(
            InlineReference::mention("ir-conversation", Icon::MessageSquare, c.conversation)
                .on_click(|_, _, _| {}),
        )
        .text(format!(" {} ", c.after))
        .reference(
            InlineReference::mention("ir-document", Icon::FileText, c.document)
                .on_click(|_, _, _| {}),
        )
        .text(c.end);
    paragraph(flow, cx)
}

fn external(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let flow = InlineFlow::new()
        .text(format!("{} ", c.ext_before))
        .reference(ext("ir-pr", PR, "github.com").label(c.pr))
        .text(format!("{} ", c.ext_mid))
        .reference(ext("ir-issue", ISSUE, "github.com"))
        .text(format!("{} ", c.ext_and))
        .reference(ext("ir-guide", GUIDE, "docs.example.com").label(c.guide))
        .text(c.ext_end);
    paragraph(flow, cx)
}

fn long(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let heading = InlineFlow::new()
        .text(format!("{} ", c.heading))
        .reference(ext("ir-heading", GUIDE, "docs.example.com").label(c.changelog));
    let body = InlineFlow::new()
        .text(format!("{} ", c.long_before))
        .reference(ext("ir-long-title", MDN, "www.electronjs.org").label(c.long_title))
        .text(format!(" {} ", c.long_mid))
        .reference(ext("ir-long-url", LONG, ""))
        .text(".");
    Stack::new()
        .gap(Space::Sm)
        .child(block(Role::H3, heading, cx))
        .child(paragraph(body, cx))
        .into_any_element()
}

fn fallback(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let flow = InlineFlow::new()
        .text(format!("{} ", c.fallback_before))
        .reference(ext("ir-broken", MDN, "developer.mozilla.org").label(c.broken))
        .text(" ")
        .reference(ext("ir-mirror", "https://mirror.example.org/butler", ""))
        .text(format!(" {}", c.fallback_end));
    paragraph(flow, cx)
}

fn unavailable(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let flow = InlineFlow::new()
        .text(format!("{} ", c.gone))
        .reference(InlineReference::mention("ir-gone", Icon::FileText, c.removed).unavailable())
        .text(format!(" {}", c.tail));
    Stack::new()
        .gap(Space::Sm)
        .child(paragraph(flow, cx))
        .into_any_element()
}
