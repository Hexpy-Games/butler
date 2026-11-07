//! UsageSummaryRows.showcase.tsx: provider usage in the composer popover's body: subscription
//! windows, API-key tokens and cost, an unpriced cost, a local model, loading, unavailable and
//! stale states, and a value change that replays.
use butler_ds::ui::blocks::progress_meter::ProgressMeter;
use butler_ds::ui::blocks::usage_summary_rows::{
    CostRow, QuotaWindow, TokenRow, UsageState, UsageSummaryRows,
};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::layout::{Justify, Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, App, Entity, IntoElement as _, ParentElement as _, Styled as _, Window, div, px,
};

use super::Story;
use crate::copy::Lang;

struct Copy {
    context: &'static str,
    full: &'static str,
    five_hour: &'static str,
    weekly: &'static str,
    resets: &'static str,
    resets_week: &'static str,
    left: fn(&str) -> String,
    input: &'static str,
    cached: &'static str,
    output: &'static str,
    reasoning: &'static str,
    cost: &'static str,
    est: &'static str,
    unavailable: &'static str,
    updated: &'static str,
    details: &'static str,
    replay: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            context: "Context window",
            full: "7% full",
            five_hour: "5-hour",
            weekly: "Weekly",
            resets: "Resets 14:00",
            resets_week: "Resets Oct 2",
            left: |p| format!("{p} left"),
            input: "Input",
            cached: "Cached",
            output: "Output",
            reasoning: "Reasoning",
            cost: "Cost",
            est: "est.",
            unavailable: "Usage unavailable",
            updated: "Updated 14:05",
            details: "Details",
            replay: "Replay",
        },
        Copy {
            context: "컨텍스트 창",
            full: "7% 사용",
            five_hour: "5시간",
            weekly: "주간",
            resets: "14:00 초기화",
            resets_week: "10월 2일 초기화",
            left: |p| format!("{p} 남음"),
            input: "입력",
            cached: "캐시",
            output: "출력",
            reasoning: "추론",
            cost: "비용",
            est: "추정",
            unavailable: "사용량 확인 불가",
            updated: "14:05 기준",
            details: "자세히",
            replay: "다시 재생",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Subscription",
            render: |l, _, _| subscription(l),
        },
        Story {
            name: "API key",
            render: |l, _, _| api_key(l, false),
        },
        Story {
            name: "API key, unpriced with reasoning",
            render: |l, _, _| unpriced(l),
        },
        Story {
            name: "Local model",
            render: |l, _, _| body(&copy(l), None),
        },
        Story {
            name: "Loading",
            render: |l, _, _| state_only(l, UsageState::Loading),
        },
        Story {
            name: "Unavailable",
            render: |l, _, _| state_only(l, UsageState::Unavailable),
        },
        Story {
            name: "Stale",
            render: stale,
        },
        Story {
            name: "Value change",
            render: replay,
        },
    ]
}

/// The composer popover body: the context meter, the usage section, Details.
fn body(c: &Copy, rows: Option<UsageSummaryRows>) -> AnyElement {
    div()
        .max_w(px(280.)) // DS: UsageSummaryRows.showcase.tsx:46
        .child(
            Stack::new()
                .gap(Space::Lg)
                .child(
                    Stack::new()
                        .gap(Space::Xs)
                        .child(
                            ProgressMeter::new("usr-context", 7.)
                                .label(c.context)
                                .meta(c.full),
                        )
                        .child(Typo::caption("18k / 258k").tone(Tone::Secondary).tabular()),
                )
                .children(rows)
                .child(
                    Stack::row().justify(Justify::End).child(
                        Button::new("usr-details")
                            .variant(Variant::Inline)
                            .size(Size::Sm)
                            .text(c.details),
                    ),
                ),
        )
        .into_any_element()
}

fn base(c: &Copy, id: &'static str) -> UsageSummaryRows {
    UsageSummaryRows::new(id, c.unavailable)
        .remaining_label(c.left)
        .estimate_label(c.est)
}

fn windows(c: &Copy, five_hour: f64) -> Vec<QuotaWindow> {
    vec![
        QuotaWindow {
            id: "5h".into(),
            label: c.five_hour.into(),
            remaining_percent: Some(five_hour),
            caption: Some(c.resets.into()),
        },
        QuotaWindow {
            id: "week".into(),
            label: c.weekly.into(),
            remaining_percent: Some(64.),
            caption: Some(c.resets_week.into()),
        },
    ]
}

fn tokens(c: &Copy, scale: f64, with_reasoning: bool) -> Vec<TokenRow> {
    let mut rows = vec![
        TokenRow {
            id: "input".into(),
            label: c.input.into(),
            value: 48_200. * scale,
        },
        TokenRow {
            id: "cached".into(),
            label: c.cached.into(),
            value: 31_900. * scale,
        },
        TokenRow {
            id: "output".into(),
            label: c.output.into(),
            value: 3_420. * scale,
        },
    ];
    if with_reasoning {
        rows.push(TokenRow {
            id: "reasoning".into(),
            label: c.reasoning.into(),
            value: 1_280. * scale,
        });
    }
    rows
}

fn subscription(lang: Lang) -> AnyElement {
    let c = copy(lang);
    let rows = base(&c, "usr-sub").quota_windows(windows(&c, 82.));
    body(&c, Some(rows))
}

fn api_key(lang: Lang, reasoning: bool) -> AnyElement {
    let c = copy(lang);
    let rows = base(&c, "usr-api")
        .tokens(tokens(&c, 1., reasoning))
        .cost(CostRow {
            label: c.cost.into(),
            usd: Some(0.0842),
            estimated: true,
        });
    body(&c, Some(rows))
}

fn unpriced(lang: Lang) -> AnyElement {
    let c = copy(lang);
    let rows = base(&c, "usr-unpriced")
        .tokens(tokens(&c, 1., true))
        .cost(CostRow {
            label: c.cost.into(),
            usd: None,
            estimated: false,
        });
    body(&c, Some(rows))
}

fn state_only(lang: Lang, state: UsageState) -> AnyElement {
    let c = copy(lang);
    let id = if state == UsageState::Loading {
        "usr-loading"
    } else {
        "usr-unavailable"
    };
    body(&c, Some(base(&c, id).state(state)))
}

fn stale(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let rows = base(&c, "usr-stale")
        .quota_windows(windows(&c, 82.))
        .updated_label(c.updated);
    body(&c, Some(rows))
}

/// A value change: each replay moves the numbers and the meters.
fn replay(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let round: Entity<usize> = window.use_keyed_state("usr-replay-round", cx, |_, _| 0);
    let step = *round.read(cx);
    let scale = [1., 1.6, 2.4][step % 3];
    let five_hour = [82., 61., 37.][step % 3];
    let rows = base(&c, "usr-replay")
        .quota_windows(windows(&c, five_hour))
        .tokens(tokens(&c, scale, true))
        .cost(CostRow {
            label: c.cost.into(),
            usd: Some(0.0842 * scale),
            estimated: true,
        });
    let button = Button::new("usr-replay-button")
        .size(Size::Sm)
        .variant(Variant::Outline)
        .text(c.replay)
        .on_click(move |_, _, cx| {
            round.update(cx, |round, cx| {
                *round += 1;
                cx.notify();
            });
        });
    Stack::new()
        .gap(Space::Md)
        .child(rows)
        .child(Stack::row().child(button))
        .into_any_element()
}
