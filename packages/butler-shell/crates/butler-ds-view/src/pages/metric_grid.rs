//! MetricGrid.showcase.tsx: dashboard metrics in a grid, and the joined stat row.
use butler_ds::ui::blocks::metric_card::{GridVariant, MetricCard, MetricGrid};
use gpui::{AnyElement, App, IntoElement as _, Window};

use super::Story;
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Dashboard metrics",
            render: dashboard,
        },
        Story {
            name: "Joined stat row",
            render: joined,
        },
    ]
}

fn dashboard(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let (completed, open, blocked, registered) = lang.pick(
        ("Completed", "Open work", "Blocked", "Registered work"),
        ("완료", "열린 작업", "막힌 작업", "등록된 작업"),
    );
    MetricGrid::new("metric-grid")
        .child(MetricCard::number("mg-completed", 3., completed))
        .child(MetricCard::number("mg-open", 7., open))
        .child(MetricCard::number("mg-blocked", 1., blocked))
        .child(MetricCard::number("mg-registered", 11., registered))
        .into_any_element()
}

fn joined(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let (lifetime, busiest, longest, streak, current) = lang.pick(
        (
            "Lifetime tokens",
            "Busiest day",
            "Longest task",
            "Longest streak",
            "Current streak",
        ),
        (
            "누적 토큰",
            "가장 많이 쓴 날",
            "가장 긴 작업",
            "최장 연속 사용",
            "연속 사용 중",
        ),
    );
    let (total, peak, peak_day, long_value, long_title) = lang.pick(
        (
            "4.41B",
            "300M",
            "Sep 14",
            "6h 41m",
            "Rewrite the release notes for preview 14",
        ),
        (
            "44.1억",
            "3억",
            "9월 14일",
            "6시간 41분",
            "프리뷰 14 릴리스 노트 다시 쓰기",
        ),
    );
    let (streak_value, streak_range, current_value) = lang.pick(
        ("41 days", "Aug 2 – Sep 11", "23 days"),
        ("41일", "8월 2일 – 9월 11일", "23일"),
    );
    let neutral = butler_ds::ui::blocks::metric_card::Trend::Neutral;
    MetricGrid::new("metric-joined")
        .variant(GridVariant::Joined)
        .child(MetricCard::text("mj-total", total, lifetime))
        .child(
            MetricCard::text("mj-peak", peak, busiest)
                .change(peak_day)
                .trend(neutral),
        )
        .child(
            MetricCard::text("mj-long", long_value, longest)
                .change(long_title)
                .trend(neutral),
        )
        .child(
            MetricCard::text("mj-streak", streak_value, streak)
                .change(streak_range)
                .trend(neutral),
        )
        .child(MetricCard::text("mj-current", current_value, current))
        .into_any_element()
}
