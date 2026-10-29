//! The shell's frame: the sidebar track (it springs open and shut), the chat card (plain paper
//! under the glass composer, or the disconnected state), the title row, the dialog and toasts.
use std::time::Duration;

use gpui::{
    AnimationExt as _, AnyElement, Context, FontWeight, IntoElement, Render, Window, canvas, div,
    prelude::*, px,
};

use super::{Shell, ToggleSidebar, system_dark};
use crate::ui::chat::column;
use crate::ui::motion::spring_slow;
use crate::ui::sidebar::{SIDEBAR_W, TRACK_MIN};
use crate::ui::theme::{FONT_BODY, over, typo};
use crate::ui::widgets::{IconButtonSpec, hover_listener, icon_button, text};

/// How long a toast stays.
const TOAST_FOR: Duration = Duration::from_millis(3000);

impl Shell {
    fn sync_children(&mut self, card_w: f32, cx: &mut Context<Self>) {
        let composer_h = self.composer_h.get();
        self.chat
            .update(cx, |c, _| c.set_layout(card_w, composer_h + 22. + 24.));
    }

    /// The disconnected state: one line in the middle of the card.
    fn disconnected_card(&self) -> AnyElement {
        let t = &self.theme;
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .pb(px(80.))
            .child(text(
                t.strings.not_running,
                typo::BODY,
                FontWeight::NORMAL,
                t.text2,
            ))
            .into_any_element()
    }

    fn chat_card(&mut self, card_w: f32) -> AnyElement {
        let t = &self.theme;
        let composer_w = if card_w <= 560. {
            card_w - 24.
        } else {
            (card_w - 88.).min(column(card_w))
        };
        let bounds = self.card_bounds.clone();
        let content = if self.source.is_some() {
            self.chat.clone().into_any_element()
        } else {
            self.disconnected_card()
        };
        let composer = div()
            .absolute()
            .left_0()
            .right_0()
            .bottom(px(22.))
            .flex()
            .justify_center()
            .child(
                div()
                    .w(px(composer_w.max(200.)))
                    .child(self.composer.clone()),
            );
        div()
            .id("chat-card")
            .relative()
            .h_full()
            .flex_1()
            .min_w_0()
            .rounded(px(12.))
            .border_1()
            .border_color(t.card_edge)
            .bg(t.paper)
            .overflow_hidden()
            .child(
                canvas(move |b, _, _| bounds.set(Some(b)), |_, (), _, _| {})
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full(),
            )
            .child(content)
            .child(composer)
            .into_any_element()
    }

    fn render_toast(&mut self, window: &mut Window) -> Option<AnyElement> {
        let (message, at) = self.toast.clone()?;
        let left = TOAST_FOR.saturating_sub(at.elapsed());
        if left.is_zero() {
            self.toast = None;
            return None;
        }
        window.request_animation_frame();
        let t = &self.theme;
        let toast = div()
            .px(px(12.))
            .py(px(6.))
            .rounded_full()
            .bg(t.surface_raised)
            .border_1()
            .border_color(t.line)
            .shadow(vec![t.glass_shadow.clone()])
            .child(text(message, typo::LABEL, FontWeight::NORMAL, t.text));
        Some(
            div()
                .absolute()
                .top(px(56.))
                .left_0()
                .right_0()
                .flex()
                .justify_center()
                .child(toast)
                .into_any_element(),
        )
    }

    fn sidebar_track(&mut self, open: bool, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let sidebar = self.render_sidebar(cx);
        div()
            .id("sidebar-track")
            .h_full()
            .flex_none()
            .relative()
            .overflow_hidden()
            .child(
                div()
                    .absolute()
                    .top_0()
                    .right_0()
                    .w(px(SIDEBAR_W))
                    .h_full()
                    .child(sidebar),
            )
            .with_spring("sidebar-track", spring_slow(open), |el, v| {
                el.w(px(TRACK_MIN + (SIDEBAR_W - TRACK_MIN) * v))
                    .opacity((v * 1.6).min(1.))
            })
    }
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.theme_override.is_none() {
            self.set_dark(system_dark(window), cx);
        }
        let open = self.sidebar_open;
        let track = if open { SIDEBAR_W } else { TRACK_MIN };
        let card_w = self
            .card_bounds
            .get()
            .map_or(window.viewport_size().width.as_f32() - track - 9., |b| {
                b.size.width.as_f32()
            });
        self.sync_children(card_w, cx);
        let t = self.theme.clone();
        let shell_bg = if self.acrylic {
            t.shell
        } else {
            over(t.shell, t.acrylic_fallback)
        };
        let track_el = self.sidebar_track(open, cx);
        let titlebar = self.render_titlebar(open, window, cx);
        let chat_card = self.chat_card(card_w);
        let dialog = self
            .card_bounds
            .get()
            .map(|card| self.render_dialog(card, window, cx))
            .unwrap_or_default();
        let toast = self.render_toast(window);
        let toggle_glyph = if open {
            "panel-left-open"
        } else {
            "panel-left"
        };
        let toggle = icon_button(
            &t,
            IconButtonSpec::new(
                "sidebar-toggle",
                toggle_glyph,
                self.hover.is("sidebar-toggle"),
            ),
            hover_listener(&"sidebar-toggle".into(), cx),
            cx.listener(|this, _, window, cx| this.toggle_sidebar(&ToggleSidebar, window, cx)),
        );
        let main = div()
            .flex_1()
            .min_w_0()
            .h_full()
            .relative()
            .pt(px(49.))
            .pr(px(8.))
            .pb(px(8.))
            .pl(px(1.))
            .flex()
            .gap(px(8.))
            .child(chat_card)
            .child(titlebar);
        div()
            .id("shell")
            .track_focus(&self.focus)
            .key_context("Shell")
            .on_action(cx.listener(Self::toggle_theme))
            .on_action(cx.listener(Self::toggle_sidebar))
            .size_full()
            .relative()
            .flex()
            .bg(shell_bg)
            .font_family(FONT_BODY)
            .text_size(px(14.))
            .line_height(px(20.))
            .text_color(t.text)
            .child(track_el)
            .child(main)
            .children(dialog)
            .child(div().absolute().left(px(14.)).top(px(9.)).child(toggle))
            .children(toast)
    }
}
