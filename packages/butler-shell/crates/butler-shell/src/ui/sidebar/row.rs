//! Sidebar rows (NavRow, NavSectionHeading, Tabs, Spinner).
use std::time::Duration;

use gpui::{
    Animation, AnimationExt as _, AnyElement, Context, FontWeight, Hsla, SharedString,
    Transformation, div, percentage, prelude::*, px,
};

use super::{Click, Tab};
use crate::ui::motion::{mix, spring_fast};
use crate::ui::shell::Shell;
use crate::ui::theme::{Theme, alpha, typo};
use crate::ui::widgets::{IconButtonSpec, hover_listener, icon, icon_button, text, tooltip};

pub(super) enum Trailing {
    None,
    Spinner,
    Chevron(bool),
}

pub(super) struct RowSpec {
    pub(super) key: SharedString,
    pub(super) icon: Option<&'static str>,
    pub(super) label: SharedString,
    pub(super) active: bool,
    pub(super) trailing: Trailing,
    pub(super) muted: bool,
    pub(super) gap: f32,
    pub(super) meta: Option<(SharedString, SharedString)>,
    /// Why the row is disabled (its tooltip), when it is.
    pub(super) disabled: Option<SharedString>,
}

impl RowSpec {
    pub(super) fn new(
        key: impl Into<SharedString>,
        icon: Option<&'static str>,
        label: impl Into<SharedString>,
    ) -> Self {
        Self {
            key: key.into(),
            icon,
            label: label.into(),
            active: false,
            trailing: Trailing::None,
            muted: false,
            gap: 10.,
            meta: None,
            disabled: None,
        }
    }

    pub(super) fn disabled(mut self, reason: Option<SharedString>) -> Self {
        self.disabled = reason;
        self
    }
}

fn trailing(spec: &RowSpec, hovered: bool, t: &Theme) -> Option<AnyElement> {
    let more = || icon("more", 16., t.text2).into_any_element();
    match spec.trailing {
        Trailing::None if hovered && spec.icon == Some("message") => Some(more()),
        Trailing::None => None,
        Trailing::Spinner | Trailing::Chevron(_) if hovered => Some(more()),
        Trailing::Spinner => Some(spinner(t.text2).into_any_element()),
        Trailing::Chevron(open) => {
            let glyph = if open {
                "chevron-down"
            } else {
                "chevron-right"
            };
            Some(icon(glyph, 16., t.text2).into_any_element())
        }
    }
}

fn meta_line(loc: SharedString, age: SharedString, t: &Theme) -> impl IntoElement {
    div()
        .flex()
        .justify_between()
        .gap(px(8.))
        .pl(px(34.))
        .pr(px(8.))
        .mt(px(-4.))
        .child(text(loc, typo::CAPTION, FontWeight::NORMAL, t.text2).truncate())
        .child(text(age, typo::CAPTION, FontWeight::NORMAL, t.text2).flex_none())
}

/// The row's content: icon, label, trailing action target and, in flat lists, the meta line.
fn row_block(spec: &RowSpec, hovered: bool, t: &Theme) -> gpui::Div {
    let enabled = spec.disabled.is_none();
    let label_color = if spec.muted || !enabled {
        t.text2
    } else {
        t.text
    };
    let weight = if spec.active {
        FontWeight::MEDIUM
    } else {
        FontWeight::NORMAL
    };
    let lead = match spec.icon {
        Some(name) => icon(name, 16., alpha(t.text, 0.82)).into_any_element(),
        None => div().w(px(16.)).flex_none().into_any_element(),
    };
    let label = text(spec.label.clone(), typo::LABEL, weight, label_color);
    let left = div()
        .flex()
        .flex_1()
        .min_w_0()
        .items_center()
        .gap(px(spec.gap))
        .child(lead)
        .child(label.flex_1().min_w_0().truncate());
    let mut row = div()
        .flex()
        .items_center()
        .gap(px(10.))
        .h(px(30.))
        .w_full()
        .px(px(8.))
        .child(left);
    if let Some(tr) = trailing(spec, hovered, t) {
        // The 30px action target sits flush with the row edge (--nav-action-edge-offset).
        let target = div()
            .size(px(30.))
            .mr(px(-8.))
            .flex_none()
            .flex()
            .items_center();
        row = row.child(target.justify_center().child(tr));
    }
    let block = div().flex().flex_col().w_full().child(row);
    match spec.meta.clone() {
        Some((loc, age)) => block.pb(px(6.)).child(meta_line(loc, age, t)),
        None => block,
    }
}

impl Shell {
    /// NavRow: 30px, 8px inline padding, 16px icon at 82%, 13px label; hover fills
    /// --selection 60% on --motion-fast, active is a flat --selection 75% with a 500 label.
    pub(super) fn nav_row(
        &mut self,
        spec: RowSpec,
        click: Click,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = self.theme.clone();
        let enabled = spec.disabled.is_none();
        let hovered = self.hover.is(&spec.key) && enabled;
        let block = row_block(&spec, hovered, &t);
        let (base, hover_bg) = if spec.active {
            (t.nav_active, t.nav_active)
        } else {
            (
                Hsla {
                    alpha: 0.,
                    ..t.nav_hover
                },
                t.nav_hover,
            )
        };
        let el = div()
            .id(spec.key.clone())
            .w_full()
            .rounded(px(8.))
            .on_hover(hover_listener(&spec.key, cx));
        let el = match spec.disabled {
            Some(reason) => el.tooltip(tooltip(reason, &t)),
            None => el
                .cursor_pointer()
                .on_click(cx.listener(move |this, _, window, cx| this.on_row(&click, window, cx))),
        };
        el.child(block)
            .with_spring(spec.key, spring_fast(hovered), move |el, v| {
                el.bg(mix(base, hover_bg, v))
            })
            .into_any_element()
    }

    /// NavSectionHeading, with the new-chat and new-folder actions when `actions`.
    pub(super) fn heading(
        &mut self,
        title: &'static str,
        actions: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = self.theme.clone();
        let mut row = div()
            .flex()
            .items_center()
            .justify_between()
            .min_h(px(30.))
            .px(px(4.))
            .child(text(title, typo::LABEL, FontWeight::MEDIUM, t.text3));
        if actions {
            let new_chat = self.disconnected();
            let mut group = div().flex().items_center().gap(px(2.)).mr(px(-4.));
            for (id, glyph, disabled) in [
                ("h-new", "pencil", new_chat),
                ("h-folder", "folder-add", Some(t.strings.not_yet.into())),
            ] {
                let key: SharedString = id.into();
                let spec = IconButtonSpec::new(id, glyph, self.hover.is(id))
                    .size(30., 14.)
                    .disabled(disabled);
                let click = cx.listener(|this, _, window, cx| this.open_chat(None, window, cx));
                group = group.child(icon_button(&t, spec, hover_listener(&key, cx), click));
            }
            row = row.child(group);
        }
        row.into_any_element()
    }

    pub(super) fn tabs(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let t = self.theme.clone();
        let mut list = div()
            .flex()
            .gap(px(4.))
            .p(px(4.))
            .border_1()
            .border_color(t.line)
            .rounded(px(8.))
            .bg(t.surface);
        for (tab, glyph, label) in [
            (Tab::All, "filter", t.strings.all),
            (Tab::Recent, "clock", t.strings.recent),
            (Tab::Running, "activity", t.strings.running),
        ] {
            let key: SharedString = format!("tab-{label}").into();
            let active = self.sidebar.tab == tab;
            let hovered = self.hover.is(&key);
            let fg = if active || hovered { t.text } else { t.text2 };
            let (off, on) = if active {
                (t.selection, t.selection)
            } else {
                (
                    Hsla {
                        alpha: 0.,
                        ..t.selection
                    },
                    alpha(t.selection, 0.72),
                )
            };
            let el = div()
                .id(key.clone())
                .flex_1()
                .min_w_0()
                .h(px(30.))
                .flex()
                .items_center()
                .justify_center()
                .gap(px(4.))
                .px(px(8.))
                .rounded(px(8.))
                .cursor_pointer()
                .on_hover(hover_listener(&key, cx))
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.on_row(&Click::Tab(tab), window, cx);
                }))
                .child(icon(glyph, 16., fg))
                .child(text(label, typo::LABEL, FontWeight::MEDIUM, fg));
            list = list.child(el.with_spring(key, spring_fast(hovered), move |el, v| {
                el.bg(mix(off, on, v))
            }));
        }
        list.into_any_element()
    }
}

/// Spinner (DS components/Spinner) approximated as a rotating 270° arc.
fn spinner(color: Hsla) -> impl IntoElement {
    icon("spinner", 16., color).with_animation(
        "spin",
        Animation::new(Duration::from_millis(2000)).repeat(),
        |el, t| el.with_transformation(Transformation::rotate(percentage(t))),
    )
}
