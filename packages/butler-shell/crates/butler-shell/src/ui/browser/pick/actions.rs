use crate::ui::browser::engine::TabId;
#[derive(Clone, Copy)]
pub(super) enum Action {
    Attach,
    Scrap,
    Save,
    Copy,
}
pub(super) fn command(_: Action, _: &TabId, _: &mut gpui::Window, _: &mut gpui::App) {}
