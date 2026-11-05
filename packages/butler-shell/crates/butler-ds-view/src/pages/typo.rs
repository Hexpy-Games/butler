//! Typo.showcase.tsx.
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::{Role, Run, TextAlign, Tone, Typo, Weight, Wrap};
use gpui::{AnyElement, IntoElement as _, ParentElement as _};

use super::Story;
use crate::copy::Lang;

struct Copy {
    body: &'static str,
    caption: &'static str,
    label: &'static str,
    code: &'static str,
    panel_title: &'static str,
    section_title: &'static str,
    metric: &'static str,
    tones: [&'static str; 8],
    weights: [&'static str; 3],
    long: &'static str,
    token: &'static str,
    inherited: &'static str,
    times: [&'static str; 4],
}

const COUNTS: [&str; 4] = ["1", "12", "128", "1,024"];
const TOKEN: &str = "https://example.com/projects/butler/specs/butler-dedicated-client-design-system/roadmap-step-4";

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            body: "Body text uses the Butler type scale.",
            caption: "Caption for metadata",
            label: "Field label",
            code: "bun run lint:ds",
            panel_title: "Panel title",
            section_title: "Section title",
            metric: "1,284",
            tones: [
                "Primary text", "Secondary metadata", "Tertiary hint", "Disabled option",
                "The request failed", "Saved", "Needs attention", "Inherits the container color",
            ],
            weights: ["Regular weight", "Medium weight", "Semibold weight"],
            long: "Desktop client polish for the project dashboard, settings screens and the conversation footer",
            token: TOKEN,
            inherited: "Typo.Text keeps the surrounding size",
            times: ["9:05 AM", "10:11 AM", "1:25 PM", "11:48 PM"],
        },
        Copy {
            body: "본문은 버틀러 타입 스케일을 사용합니다.",
            caption: "메타데이터 캡션",
            label: "필드 레이블",
            code: "bun run lint:ds",
            panel_title: "패널 제목",
            section_title: "섹션 제목",
            metric: "1,284",
            tones: [
                "기본 텍스트", "보조 메타데이터", "3차 힌트", "비활성 옵션", "요청에 실패했습니다",
                "저장됨", "확인이 필요합니다", "컨테이너 색을 이어받습니다",
            ],
            weights: ["보통 굵기", "중간 굵기", "세미볼드 굵기"],
            long: "프로젝트 대시보드, 설정 화면과 대화 하단 정보를 다듬는 데스크톱 클라이언트 작업",
            token: TOKEN,
            inherited: "Typo.Text는 주변 크기를 그대로 씁니다",
            times: ["오전 9:05", "오전 10:11", "오후 1:25", "오후 11:48"],
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Variants",
            render: |l, _, _| variants(l),
        },
        Story {
            name: "Tones",
            render: |l, _, _| tones(l),
        },
        Story {
            name: "Weights",
            render: |l, _, _| weights(l),
        },
        Story {
            name: "Truncate and clamp",
            render: |l, _, _| truncate(l),
        },
        Story {
            name: "Message clamp",
            render: |l, _, _| message(l),
        },
        Story {
            name: "Wrapping",
            render: |l, _, _| wrapping(l),
        },
        Story {
            name: "Tabular numbers, end aligned",
            render: |l, _, _| tabular(l),
        },
        Story {
            name: "Inherited text",
            render: |l, _, _| inherited(l),
        },
        Story {
            name: "Literal values",
            render: |_, _, _| literal(),
        },
        Story {
            name: "Beside a control and preformatted",
            render: |_, _, _| beside(),
        },
    ]
}

fn variants(lang: Lang) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Sm)
        .child(Typo::new(Role::PanelTitle, c.panel_title))
        .child(Typo::new(Role::SectionTitle, c.section_title))
        .child(Typo::body(c.body))
        .child(Typo::label(c.label))
        .child(Typo::caption(c.caption))
        .child(Typo::code(c.code))
        .child(Typo::metric_value(c.metric).tabular())
        .into_any_element()
}

fn tones(lang: Lang) -> AnyElement {
    let c = copy(lang);
    let order = [
        Tone::Primary,
        Tone::Secondary,
        Tone::Tertiary,
        Tone::Disabled,
        Tone::Danger,
        Tone::Success,
        Tone::Warning,
        Tone::Inherit,
    ];
    Stack::new()
        .gap(Space::Xs)
        .children(
            order
                .into_iter()
                .zip(c.tones)
                .map(|(tone, text)| Typo::body(text).tone(tone)),
        )
        .into_any_element()
}

fn weights(lang: Lang) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Xs)
        .children(
            [Weight::Regular, Weight::Medium, Weight::Semibold]
                .into_iter()
                .zip(c.weights)
                .map(|(weight, text)| Typo::body(text).weight(weight)),
        )
        .into_any_element()
}

fn truncate(lang: Lang) -> AnyElement {
    let long = copy(lang).long;
    Stack::new()
        .gap(Space::Md)
        .child(Typo::body(long).truncate())
        .child(Typo::body(format!("{long}. {long}")).line_clamp(2))
        .child(
            Typo::caption(format!("{long}. {long}. {long}"))
                .line_clamp(3)
                .tone(Tone::Secondary),
        )
        .into_any_element()
}

fn message(lang: Lang) -> AnyElement {
    let c = copy(lang);
    let text = [c.long, c.caption, c.long, c.caption, c.long].join("\n");
    Typo::text(text)
        .wrap(Wrap::Pre)
        .line_clamp(5)
        .into_any_element()
}

fn wrapping(lang: Lang) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Md)
        .child(
            Typo::caption(c.caption)
                .wrap(Wrap::Nowrap)
                .tone(Tone::Secondary),
        )
        .child(Typo::body(c.token).wrap(Wrap::Anywhere))
        .into_any_element()
}

fn tabular(lang: Lang) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Xs)
        .children(c.times.into_iter().zip(COUNTS).map(|(time, count)| {
            Typo::caption(format!("{time} · {count}"))
                .align(TextAlign::End)
                .tabular()
                .tone(Tone::Secondary)
        }))
        .into_any_element()
}

fn inherited(lang: Lang) -> AnyElement {
    let c = copy(lang);
    Typo::runs(
        Role::Label,
        [
            Run::new(format!("{} · ", c.label)),
            Run::new(c.inherited)
                .tone(Tone::Secondary)
                .weight(Weight::Regular),
        ],
    )
    .into_any_element()
}

fn literal() -> AnyElement {
    let path = "/Users/example/shots/2876x6/a->b.png";
    Stack::new()
        .gap(Space::Xs)
        .child(Typo::body(path).wrap(Wrap::Anywhere))
        .child(Typo::body(path).wrap(Wrap::Anywhere).literal())
        .into_any_element()
}

fn beside() -> AnyElement {
    Stack::new()
        .gap(Space::Md)
        .child(
            Typo::body("alignWith=\"control\" centers the first line on a control.")
                .tone(Tone::Secondary)
                .wrap(Wrap::Anywhere)
                .align_with_control(),
        )
        .child(
            Typo::code("{\n  \"event\": \"turn.completed\"\n}")
                .tone(Tone::Primary)
                .wrap(Wrap::Pre),
        )
        .into_any_element()
}
