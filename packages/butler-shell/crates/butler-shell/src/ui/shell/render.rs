//! The app's DS cards frame; the rows and composer retain their existing content.
use blocks::adaptive_shell::{AdaptiveShell, HandleSide, ShellPlatform, ShellWindow};
use blocks::adaptive_shell::{
    grip::{HintSide, ResizeHandle},
    parts::{ChromeFloatingToggle, ShellCard},
    peek::{self, SidebarPeek},
};
use blocks::{
    conversation_shell::ConversationShell, responsive::ChromeEnvironment, scope::ShellFrame,
};
use butler_ds::tokens::{Color, Length};
use butler_ds::ui::{blocks, context::Ds, focus, icon_button::IconButton, overlay, toast};
use gpui::{AnyElement, Context, IntoElement, Render, Window, canvas, div, prelude::*};

use super::{Shell, TextSizeDown, TextSizeReset, TextSizeUp, ToggleSidebar, system_dark};
use crate::ui::Icon;
use crate::ui::widgets::anchor;

impl Shell {
    fn conversation(&self, cx: &Context<Self>) -> AnyElement {
        let bounds = self.card_bounds.clone();
        let content = if self.source.is_some() {
            self.chat.clone().into_any_element()
        } else {
            div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .child(butler_ds::ui::typo::Typo::body(
                    self.theme.strings.not_running,
                ))
                .into_any_element()
        };
        let reserve = self.composer_h.get() + f32::from(Ds::get(cx).len(Length::SpaceLg)) * 2.;
        anchor(div(), "chat-card")
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .child(
                canvas(move |b, _, _| bounds.set(Some(b)), |_, (), _, _| {})
                    .absolute()
                    .size_full(),
            )
            .child(
                ShellCard::new().child(
                    ConversationShell::new("conversation", reserve)
                        .child(content)
                        .child(self.composer.clone()),
                ),
            )
            .into_any_element()
    }

    fn resize_handle(&self, cx: &Context<Self>) -> ResizeHandle {
        let drag = cx.entity().downgrade();
        let key = drag.clone();
        ResizeHandle::new("sidebar-resize", HintSide::End)
            .label(self.copy("Resize sidebar", "사이드바 크기 조절"))
            .hint(self.copy("Drag to resize", "드래그하여 조절"))
            .on_drag(move |event, _, cx| {
                let _ = drag.update(cx, |s, cx| s.sidebar_drag(event, cx));
            })
            .on_key_down(move |event, _, cx| {
                let _ = key.update(cx, |s, cx| {
                    let width = match event.keystroke.key.as_str() {
                        "left" => s.sidebar_width(cx) - 16.,
                        "right" => s.sidebar_width(cx) + 16.,
                        "home" => 248.,
                        "end" => 420.,
                        _ => return,
                    };
                    cx.stop_propagation();
                    s.resize_sidebar(width, cx);
                });
            })
    }

    fn adaptive_frame(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let size = window.viewport_size();
        let mut input = ShellWindow::new(size.width.into(), size.height.into());
        input.fullscreen = window.is_fullscreen();
        let platform = match self.theme.platform {
            crate::ui::theme::Platform::Mac => ShellPlatform::Darwin,
            crate::ui::theme::Platform::Windows => ShellPlatform::Win32,
            crate::ui::theme::Platform::Linux => ShellPlatform::Linux,
        };
        let drawer = input.width <= 640.;
        let open = self.sidebar_open && (drawer || input.width >= 720.);
        let peek = SidebarPeek::new("sidebar-peek", !drawer && !open, window, cx);
        let toggle = IconButton::new(
            "sidebar-toggle",
            if open {
                self.copy("Hide sidebar", "사이드바 숨기기")
            } else {
                self.copy("Show sidebar", "사이드바 보기")
            },
        )
        .glyph(if open {
            Icon::PanelLeftOpen
        } else {
            Icon::PanelLeft
        })
        .on_click(cx.listener(|s, _, w, cx| s.toggle_sidebar(&ToggleSidebar, w, cx)));
        let dismiss = cx.entity().downgrade();
        let width = self.sidebar_width(cx);
        let sidebar = self.render_sidebar(cx);
        let title = self.render_titlebar(open, window, cx);
        let mut shell = AdaptiveShell::new("app-frame", input)
            .frame(ShellFrame::Cards)
            .chrome_environment(ChromeEnvironment::Electron)
            .platform(platform)
            .left_open(open)
            .compact_sidebar_full_width(true)
            .panel_widths(width, 376.)
            .resizing(self.frame.resize_start.is_some())
            .peek(peek)
            .sidebar(sidebar)
            .title(title)
            .workspace(self.conversation(cx))
            .chrome(ChromeFloatingToggle::new(
                "chrome",
                anchor(div(), "sidebar-toggle").child(toggle),
            ))
            .scrim(move |_, cx| {
                let _ = dismiss.update(cx, |s, cx| {
                    s.sidebar_open = false;
                    cx.notify();
                });
            });
        if open && !drawer {
            shell = shell.resize_handle(
                HandleSide::Left,
                anchor(div(), "sidebar-resize")
                    .h_full()
                    .child(self.resize_handle(cx)),
            );
        }
        shell.into_any_element()
    }
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.theme_override.is_none() {
            self.set_dark(system_dark(window), cx);
        }
        self.frame_inputs(window, cx);
        if self.source.is_some()
            && let Some(request) = self.pending_navigation.take()
        {
            self.navigate(request, window, cx);
        }
        let frame = self.adaptive_frame(window, cx);
        let dialog = self
            .card_bounds
            .get()
            .map(|b| self.render_dialog(b, window, cx))
            .unwrap_or_default();
        let rename = self.render_rename(window, cx);
        let ds = Ds::get(cx);
        let root = div()
            .track_focus(&self.focus)
            .key_context("Shell")
            .on_action(cx.listener(Self::toggle_sidebar))
            .on_action(cx.listener(Self::focus_composer))
            .on_action(|_: &TextSizeUp, _, cx| Self::text_size(1, cx))
            .on_action(|_: &TextSizeDown, _, cx| Self::text_size(-1, cx))
            .on_action(|_: &TextSizeReset, _, cx| Self::text_size(0, cx))
            .capture_key_down(|e, w, cx| {
                if e.keystroke.key == "escape" {
                    peek::escape(w, cx);
                }
            })
            .size_full()
            .relative()
            .font_family(ds.body_font().clone())
            .text_size(ds.len(Length::TypoBodySize))
            .line_height(ds.len(Length::TypoBodyLineHeight))
            .text_color(ds.color(Color::TextPrimary))
            .child(frame)
            .children(dialog)
            .child(rename)
            .child(toast::Toaster::new().offset(ds.len(Length::TitlebarSafeAreaTop)));
        overlay::track(toast::track(focus::track_modality(div())))
            .id("shell-root")
            .size_full()
            .child(root)
    }
}
