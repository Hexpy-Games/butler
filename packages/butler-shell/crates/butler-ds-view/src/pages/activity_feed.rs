//! ActivityFeed.showcase.tsx: the summary progress (state icons on the title line), rows with a
//! description and meta, the empty state and the composer surface.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::activity_feed::{ActivityFeed, ActivityFeedItem, FeedSurface};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::spinner::Spinner;
use gpui::{AnyElement, App, IntoElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    progress: &'static str,
    empty: &'static str,
    worker: &'static str,
    rows: [&'static str; 4],
    plan: &'static str,
    plan_meta: &'static str,
    design: &'static str,
    validation: &'static str,
    validation_meta: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            progress: "Progress",
            empty: "No progress yet.",
            worker: "Worker activity",
            rows: [
                "Read the settings pages",
                "Compared header spacing at 375 and 1440",
                "Waiting for the S7 branch",
                "Write the report",
            ],
            plan: "Plan updated",
            plan_meta: "now",
            design: "Design-system expansion",
            validation: "Validation passed",
            validation_meta: "2m",
        },
        Copy {
            progress: "진행",
            empty: "아직 진행 상황이 없습니다.",
            worker: "Worker 활동",
            rows: [
                "설정 페이지 읽기",
                "375와 1440에서 헤더 간격 비교",
                "S7 브랜치 기다리는 중",
                "보고서 작성",
            ],
            plan: "계획 갱신",
            plan_meta: "방금",
            design: "디자인 시스템 확장",
            validation: "검증 통과",
            validation_meta: "2분",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Summary progress",
            render: summary,
        },
        Story {
            name: "Description and meta",
            render: described,
        },
        Story {
            name: "Empty",
            render: empty,
        },
        Story {
            name: "Composer surface",
            render: composer,
        },
    ]
}

fn glyph(glyph: Icon, cx: &App) -> AnyElement {
    icon(glyph, IconSize::Md, Ds::get(cx)).into_any_element()
}

fn summary(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let [done, compared, waiting, next] = c.rows;
    ActivityFeed::new(
        "af-summary",
        vec![
            ActivityFeedItem::new("1", done).icon(glyph(Icon::CheckIcon, cx)),
            ActivityFeedItem::new("2", compared).icon(glyph(Icon::CheckIcon, cx)),
            ActivityFeedItem::new("3", waiting).icon(Spinner::new("af-spin-3")),
            ActivityFeedItem::new("4", next).icon(glyph(Icon::Circle, cx)),
        ],
    )
    .title(c.progress)
    .into_any_element()
}

fn described(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    ActivityFeed::new(
        "af-described",
        vec![
            ActivityFeedItem::new("1", c.plan)
                .icon(glyph(Icon::CircleAlert, cx))
                .description(c.design)
                .meta(c.plan_meta),
            ActivityFeedItem::new("2", c.validation)
                .icon(glyph(Icon::CheckIcon, cx))
                .meta(c.validation_meta),
        ],
    )
    .title(c.worker)
    .into_any_element()
}

fn empty(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    ActivityFeed::new("af-empty", Vec::new())
        .title(c.progress)
        .empty_label(c.empty)
        .into_any_element()
}

fn composer(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    ActivityFeed::new(
        "af-composer",
        vec![
            ActivityFeedItem::new("1", c.rows[2])
                .icon(Spinner::new("af-spin-composer"))
                .meta(c.plan_meta),
        ],
    )
    .surface(FeedSurface::Composer)
    .title(c.worker)
    .into_any_element()
}
