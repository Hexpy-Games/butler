//! StatusCapsule.showcase.tsx: running work above the composer, with and without detail.
use butler_ds::ui::blocks::status_capsule::StatusCapsule;
use butler_ds::ui::layout::{Align, Justify, Space, Stack};
use butler_ds::ui::spinner::Spinner;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    title: &'static str,
    detail: &'static str,
    short: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            title: "Review the activity surface and every settings page",
            detail: "Validating the activity surface",
            short: "Preparing the report",
        },
        Copy {
            title: "활동 화면과 모든 설정 페이지 검토",
            detail: "활동 화면 확인 중",
            short: "보고서 준비 중",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![Story {
        name: "Running work above the composer",
        render: running,
    }]
}

fn running(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::row()
        .align(Align::Row)
        .gap(Space::Xs)
        .justify(Justify::Center)
        .wrap(true)
        .child(
            StatusCapsule::new("sc-long", c.title)
                .icon(Spinner::new("sc-long-spinner"))
                .detail(c.detail)
                .progress("2/3")
                .on_click(|_, _, _| {}),
        )
        .child(
            StatusCapsule::new("sc-short", c.short)
                .icon(Spinner::new("sc-short-spinner"))
                .on_click(|_, _, _| {}),
        )
        .into_any_element()
}
