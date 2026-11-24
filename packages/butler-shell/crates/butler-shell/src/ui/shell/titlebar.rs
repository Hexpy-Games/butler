//! Product title and workspace identity inside the DS titlebar; a management view shows its own
//! title (`activeTitleForView`) and, when nested, the back button (`useTitlebarBack`).
use super::Shell;
use crate::ui::manage::route;
use crate::ui::{Icon, source::wire};
use butler_ds::tokens::Length;
use butler_ds::ui::{
    blocks::scope::{self, ActionScale, Spec},
    blocks::titlebar_shell::TitlebarShell,
    context::{Ds, Lang},
    icon_button::IconButton,
    typo::Typo,
    window_drag,
};
use gpui::{
    AnyElement, App, Context, IntoElement as _, Window, WindowControlArea, div, prelude::*, px,
};

impl Shell {
    fn title_copy(&self, cx: &Context<Self>) -> (gpui::SharedString, Option<AnyElement>) {
        let row = self.store.selected().and_then(|c| self.store.summary(c));
        let title = row.map_or_else(|| self.theme.strings.new_chat.into(), |r| r.title.clone());
        let project = row
            .and_then(|r| r.space.as_ref())
            .filter(|s| s.project)
            .map(|s| s.title.to_string());
        let workspace = self
            .session_menu
            .summary
            .as_ref()
            .and_then(|s| s.branch_info.as_ref())
            .and_then(|b| {
                let branch = b
                    .branch_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|b| !b.is_empty());
                let label = match b.workspace_binding.as_ref()? {
                    wire::SessionViewBranchWorkspaceBinding::SessionFolder => b
                        .workspace_label
                        .as_deref()
                        .map(str::trim)
                        .filter(|label| !label.is_empty())?,
                    wire::SessionViewBranchWorkspaceBinding::SessionWorktree => {
                        self.copy("Worktree", "워크트리")
                    }
                    wire::SessionViewBranchWorkspaceBinding::Project => self.copy("Local", "로컬"),
                    wire::SessionViewBranchWorkspaceBinding::Unknown => return None,
                };
                let glyph = if matches!(
                    b.workspace_binding,
                    Some(wire::SessionViewBranchWorkspaceBinding::SessionFolder)
                ) {
                    Icon::Folder
                } else {
                    Icon::GitBranch
                };
                Some((
                    glyph,
                    branch.map_or_else(|| label.to_owned(), |b| format!("{label} · {b}")),
                ))
            });
        use butler_ds::ui::{
            icon::{IconSize, icon},
            icon_slot::{IconSlot, SlotSize, SlotTone},
            layout::{Cross, Space, Stack},
        };
        let subtitle = (project.is_some() || workspace.is_some()).then(|| {
            Stack::row()
                .cross(Cross::Center)
                .gap(Space::Sm)
                .children(project.map(|label| Typo::caption(label).truncate()))
                .children(workspace.map(|(glyph, label)| {
                    Stack::row()
                        .cross(Cross::Center)
                        .gap(Space::Xs)
                        .child(
                            IconSlot::new()
                                .size(SlotSize::Xs)
                                .tone(SlotTone::Secondary)
                                .child(icon(glyph, IconSize::Xs, Ds::get(cx))),
                        )
                        .child(Typo::caption(label).truncate())
                }))
                .into_any_element()
        });
        (title, subtitle)
    }

    pub(super) fn render_titlebar(
        &mut self,
        open: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let lang = self.theme.strings.locale.ds_lang();
        let session = self.on_session(cx);
        let (title, subtitle) = match route::active_title(&self.view(cx), lang, cx) {
            Some(title) => (title, None),
            None => self.title_copy(cx),
        };
        let mut bar = TitlebarShell::new("workspace-title", title)
            .collapsed(!open)
            .split_chat_width(self.split_chat_width())
            .drag_region();
        if self.view(cx) == crate::ui::manage::View::Browser
            && let Some(leading) = crate::ui::browser::transfer::hub(window, cx)
        {
            bar = bar
                .leading(leading)
                .leading_size(butler_ds::ui::blocks::titlebar_shell::LeadingSize::Auto);
        }
        if let Some(subtitle) = subtitle {
            bar = bar.subtitle(subtitle);
        }
        if let Some(label) = self.back_label(cx) {
            bar = bar.back(label, cx.listener(|s, _, w, cx| s.titlebar_back(w, cx)));
        }
        if session && self.store.selected().is_some() {
            bar = bar.title_actions(self.render_session_menu(window, cx));
        }
        if session && let Some(actions) = self.session_actions(window, cx) {
            bar = bar.chat_trailing(actions);
        }
        if session && let Some(toggle) = self.browser_toggle(cx) {
            use butler_ds::ui::layout::{Space, Stack};
            bar = bar.trailing(
                Stack::row()
                    .gap(Space::None)
                    .child(toggle)
                    .children(self.viewer_toggle(cx)),
            );
        }
        crate::ui::widgets::anchor(div(), "titlebar")
            .w_full()
            .child(bar)
            .into_any_element()
    }
}

/// The controls' inset from the window's end edge.
const CONTROLS_INSET: f32 = 10.; // DS: TitlebarShell.module.css:91
/// Fallback of `--titlebar-action-size`.
const ACTION_SIZE: f32 = 30.; // DS: TitlebarShell.module.css:80

impl Shell {
    /// Minimize, maximize and close belong to the window, not to a screen: one layer at the end
    /// of the title band over whatever the frame shows, under the dialogs and the DS top layer,
    /// which paint after it. Every screen keeps a drag band under it; `no_drag` cuts the buttons
    /// out of it. macOS draws its own traffic lights.
    pub(super) fn window_controls_layer(&self, cx: &App) -> Option<AnyElement> {
        if matches!(self.theme.platform, crate::ui::theme::Platform::Mac) {
            return None;
        }
        let ds = Ds::get(cx);
        let tokens = ds.tokens();
        let scale = ActionScale {
            side: tokens
                .try_len(Length::TitlebarActionSize)
                .unwrap_or(ACTION_SIZE),
            icon: tokens
                .try_len(Length::TitlebarActionIconSize)
                .unwrap_or_else(|| f32::from(ds.len(Length::IconSizeMd))),
            fixed: false,
        };
        let lang = self.theme.strings.locale.ds_lang();
        let controls =
            window_drag::no_drag(div().flex().items_center().child(window_controls(lang)));
        let spec = Spec {
            action: Some(scale),
            ..Spec::default()
        };
        Some(
            div()
                .absolute()
                .top_0()
                .right(px(CONTROLS_INSET))
                .h(ds.len(Length::TitlebarHeight))
                .flex()
                .items_center()
                .child(scope::scoped(spec, controls))
                .into_any_element(),
        )
    }
}

/// Minimize, maximize and close (Windows and Linux).
fn window_controls(lang: Lang) -> AnyElement {
    let copy = |en: &'static str, ko: &'static str| if lang == Lang::Ko { ko } else { en };
    let mut row = div().flex().items_center();
    for (id, label, glyph, area) in [
        (
            "wc-min",
            copy("Minimize", "최소화"),
            Icon::Minus,
            WindowControlArea::Min,
        ),
        (
            "wc-max",
            copy("Maximize", "최대화"),
            Icon::Square,
            WindowControlArea::Max,
        ),
        (
            "wc-close",
            copy("Close", "닫기"),
            Icon::X,
            WindowControlArea::Close,
        ),
    ] {
        row = row.child(
            crate::ui::widgets::anchor(div(), id)
                .window_control_area(area)
                .child(IconButton::new(id, label).glyph(glyph).on_click(
                    move |_, w, _| match area {
                        WindowControlArea::Min => w.minimize_window(),
                        WindowControlArea::Max => w.zoom_window(),
                        _ => w.remove_window(),
                    },
                )),
        );
    }
    row.into_any_element()
}
