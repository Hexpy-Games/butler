//! `management/AutomationsList.tsx`: the 예약 작업 list.
pub(super) mod copy;
pub(super) mod login;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::dashboard_header::DashboardHeader;
use butler_ds::ui::blocks::empty_line::EmptyLine;
use butler_ds::ui::blocks::list_row::ListRow;
use butler_ds::ui::blocks::management_page::ManagementPage;
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::clickable::Clickable;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::skeleton::SkeletonRows;
use gpui::{
    App, InteractiveElement as _, IntoElement, ParentElement as _, RenderOnce, SharedString,
    Styled as _, Window, div,
};

use super::labels::{schedule_frequency, schedule_next_run, schedule_state};
use super::types::AutomationSummary;
use crate::ui::composer::menus::{access_label, access_mode_icon};
use crate::ui::manage::{Action, Pick};
use crate::ui::source::wire::AccessMode;
use crate::ui::widgets::anchor;
use copy::words;

/// `AutomationsList`: `loaded` is false until the first load settles (skeleton rows, not the
/// empty line).
#[derive(IntoElement)]
pub(super) struct AutomationsList {
    pub(super) automations: Vec<AutomationSummary>,
    pub(super) loaded: bool,
    pub(super) on_select: Pick<SharedString>,
    pub(super) on_new: Action,
}

impl RenderOnce for AutomationsList {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let lang = ds.lang();
        let words = words(lang);
        let new = self.on_new.clone();
        let header = DashboardHeader::new(crate::ui::i18n::manage::words(lang).automations_title)
            .meta((words.scheduled_count)(self.automations.len()))
            .action(
                anchor(div().id("automation-new-anchor"), "automation-new").child(
                    Button::new("automation-new")
                        .variant(Variant::Outline)
                        .icon_start(icon(Icon::Plus, IconSize::Md, ds))
                        .text(words.new)
                        .on_click(move |_, window, cx| new(window, cx)),
                ),
            );
        let mut rows = Stack::new().gap(Space::Xs);
        if !self.loaded {
            rows = rows.child(SkeletonRows::new("automations-loading").rows(3));
        } else if self.automations.is_empty() {
            rows = rows.child(EmptyLine::new(words.empty));
        } else {
            for (index, automation) in self.automations.iter().enumerate() {
                let name = if index == 0 {
                    "automation-row"
                } else {
                    "automation-row-next"
                };
                rows = rows.child(
                    anchor(
                        div().id(SharedString::from(format!("automation-row-{index}"))),
                        name,
                    )
                    .child(row(automation, &self.on_select, lang, ds)),
                );
            }
        }
        anchor(div().id("automations-view").size_full(), "automations-view")
            .child(ManagementPage::new("automations").child(header).child(rows))
    }
}

/// One schedule: its access icon, title, target and `state · frequency · next · access`.
fn row(
    automation: &AutomationSummary,
    on_select: &Pick<SharedString>,
    lang: butler_ds::ui::context::Lang,
    ds: &Ds,
) -> Clickable {
    let known = automation.access_mode != AccessMode::Unknown;
    let meta = [
        schedule_state(&automation.state, lang).to_owned(),
        schedule_frequency(automation, lang),
        schedule_next_run(automation, lang),
        if known {
            access_label(&automation.access_mode, lang).to_owned()
        } else {
            String::new()
        },
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" · ");
    let mut item = ListRow::new(automation.title.clone())
        .description(automation.target_label.clone())
        .meta(meta);
    if known {
        item = item.icon(access_mode_icon(&automation.access_mode, IconSize::Md, ds));
    }
    let id: SharedString = automation.id.clone().into();
    let select = on_select.clone();
    Clickable::new(SharedString::from(format!("automation-{id}")))
        .stretch()
        .on_click(move |_, window, cx| select(id.clone(), window, cx))
        .child(item)
}
