//! ComposerAdjunctPanel.showcase.tsx: the panel attached to the composer, and one collapsed by
//! default.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::composer_adjunct_panel::ComposerAdjunctPanel;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use super::attached_composer::attached;
use crate::copy::Lang;

fn copy(lang: Lang) -> (&'static str, &'static str, &'static str) {
    lang.pick(
        (
            "Attached panel",
            "Panel content follows the composer inset rhythm. TodoProgressPanel and WorkerActivityPanel build on this shell.",
            "3 of 5 steps done",
        ),
        (
            "첨부 패널",
            "패널 내용은 컴포저의 안쪽 여백 리듬을 따릅니다. TodoProgressPanel과 WorkerActivityPanel이 이 틀 위에 만들어집니다.",
            "5단계 중 3단계 완료",
        ),
    )
}

fn panel(lang: Lang, id: &'static str, collapsed: bool, cx: &App) -> ComposerAdjunctPanel {
    let (heading, body, summary) = copy(lang);
    let mut panel = ComposerAdjunctPanel::new(id)
        .heading(heading)
        .icon(icon(Icon::ListChecks, IconSize::Md, Ds::get(cx)))
        .collapsed_summary(summary)
        .child(Typo::body(body));
    if collapsed {
        panel = panel.default_collapsed();
    }
    panel
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Attached to the composer",
            render: |lang, window, cx| attached_story(lang, window, cx),
        },
        Story {
            name: "Collapsed by default",
            render: |lang, _, cx| panel(lang, "adjunct-collapsed", true, cx).into_any_element(),
        },
    ]
}

fn attached_story(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let adjunct = panel(lang, "adjunct-attached", false, cx);
    attached(lang, "adjunct-composer", adjunct, window, cx)
}
