//! RollingStatusLine.showcase.tsx.
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::rolling_status_line::RollingStatusLine;
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, Window, div, px};

use super::Story;
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Short status",
            render: |lang, _, _| {
                line(
                    "rolling-short",
                    lang.pick("Generating a response", "응답을 만드는 중"),
                )
            },
        },
        Story {
            name: "Long status truncates",
            render: long,
        },
    ]
}

fn line(id: &'static str, text: &'static str) -> AnyElement {
    RollingStatusLine::new()
        .child(
            Stack::row()
                .gap(Space::Sm)
                .cross(Cross::Center)
                .child(Spinner::new(id).size(14.))
                .child(Typo::body(text).truncate()),
        )
        .into_any_element()
}

fn long(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let text = lang.pick(
        "Reading the settings screen, the design-system tokens and the three failing layout tests before proposing a fix",
        "설정 화면과 디자인 시스템 토큰, 실패한 레이아웃 테스트 세 개를 먼저 읽고 나서 수정 방법을 제안하는 중",
    );
    // DS: RollingStatusLine.showcase.tsx:41 (`maxWidth: 360`)
    div()
        .max_w(px(360.))
        .child(line("rolling-long", text))
        .into_any_element()
}
