//! The app's DS cards frame; the rows and composer retain their existing content.
use blocks::adaptive_shell::{AdaptiveShell, HandleSide, ShellPlatform, ShellWindow};
use blocks::adaptive_shell::{
    grip::{HintSide, ResizeHandle},
    parts::{ChromeFloatingToggle, ShellCard},
    peek::{self, CloseReason, SidebarPeek},
};
use blocks::{
    conversation_shell::ConversationShell, responsive::ChromeEnvironment, scope::ShellFrame,
};
use butler_ds::tokens::{Color, Length};
use butler_ds::ui::{blocks, context::Ds, focus, icon_button::IconButton, overlay, toast};
use gpui::{AnyElement, Context, Entity, IntoElement, Render, Window, div, prelude::*};

use super::{
    Shell, TextSizeDown, TextSizeReset, TextSizeUp, TitlebarBack, ToggleSidebar, image_viewer,
    region, system_dark,
};
use crate::ui::Icon;
use crate::ui::lifecycle_view;
use crate::ui::onboarding::{self, gate::Gate};
use crate::ui::settings::SettingsView;
use crate::ui::widgets::anchor;

impl Shell {
    pub(super) fn conversation(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
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
        let notice = self.live_notice(window, cx);
        anchor(div(), "chat-card")
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .children(notice)
            .child(
                ShellCard::new().child(
                    self.with_aside(ConversationShell::new("conversation", reserve))
                        .child(content)
                        .child(self.composer.clone()),
                ),
            )
            .into_any_element()
    }

    /// `LiveConnectionNotice` (`AgentStatusNotice`): above the conversation, and at the top of a
    /// management page's card.
    fn live_notice(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let lang = self.theme.strings.locale.ds_lang();
        crate::lifecycle::runtime(cx).and_then(|runtime| {
            runtime.update(cx, |runtime, cx| {
                lifecycle_view::agent_notice(runtime, lang, window, cx)
            })
        })
    }

    /// A management view's workspace (`AppShell.tsx:228-237`): the page in an
    /// `AdaptiveShellCard` under the `LiveConnectionNotice`; `None` for the conversation.
    fn manage_workspace(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let page = self.manage_page()?;
        self.clear_split();
        let notice = self.live_notice(window, cx);
        Some(
            // A column, so the card's `flex: auto` fills the workspace body as the
            // conversation's card does.
            anchor(div(), "manage-card")
                .size_full()
                .flex()
                .flex_col()
                .child(
                    ShellCard::new().child(
                        div()
                            .flex_auto()
                            .min_h_0()
                            .flex()
                            .flex_col()
                            .children(notice)
                            .child(
                                div()
                                    .flex_1()
                                    .min_h_0()
                                    // A column, so a page whose root takes `flex: 1` (a
                                    // `ScrollArea::fill`) fills the slot.
                                    .child(page.cached(region::fill().flex().flex_col())),
                            ),
                    ),
                )
                .into_any_element(),
        )
    }

    /// The conversation's aside: the session sections while session info is open.
    fn with_aside(&self, shell: ConversationShell) -> ConversationShell {
        match self.aside() {
            // `Conversation.tsx`: `asideFloatOpen={infoShown}`, the same fact as the aside.
            Some(aside) => shell.aside(aside).aside_float_open(true),
            None => shell,
        }
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

    /// The window chrome's sidebar toggle; while a pane folds the sidebar (`peek`), it peeks.
    fn sidebar_toggle(
        &self,
        open: bool,
        peek: Option<SidebarPeek>,
        cx: &mut Context<Self>,
    ) -> IconButton {
        IconButton::new(
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
        .on_click(cx.listener(move |s, _, w, cx| {
            if let Some(peek) = &peek {
                if peek.open(cx) {
                    peek.close(CloseReason::PressOutside, w, cx);
                } else {
                    peek.show(w, cx);
                }
            } else {
                s.toggle_sidebar(&ToggleSidebar, w, cx);
            }
        }))
    }

    /// The AdaptiveShell window facts: the window's size and the platform.
    pub(super) fn shell_window(&self, window: &Window) -> (ShellWindow, ShellPlatform) {
        let size = window.viewport_size();
        let mut input = ShellWindow::new(size.width.into(), size.height.into());
        input.fullscreen = window.is_fullscreen();
        let platform = match self.theme.platform {
            crate::ui::theme::Platform::Mac => ShellPlatform::Darwin,
            crate::ui::theme::Platform::Windows => ShellPlatform::Win32,
            crate::ui::theme::Platform::Linux => ShellPlatform::Linux,
        };
        (input, platform)
    }

    /// `AppShell` with `settingsActive`: the settings screen is the shell's only child (no
    /// sidebar, title row or window chrome).
    fn settings_frame(&self, view: Entity<SettingsView>, window: &Window) -> AnyElement {
        let (input, platform) = self.shell_window(window);
        AdaptiveShell::new("app-frame", input)
            .frame(ShellFrame::Cards)
            .chrome_environment(ChromeEnvironment::Electron)
            .platform(platform)
            .settings_active(true)
            .settings(view)
            .into_any_element()
    }

    /// What fills the window (`AppShell`, `AppOnboardingShell`): the quit card, the legacy
    /// recovery, the boot state while the gate waits, the setup, then the settings or the frame.
    fn frame(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let lang = self.theme.strings.locale.ds_lang();
        let runtime = crate::lifecycle::runtime(cx);
        if runtime
            .as_ref()
            .is_some_and(|runtime| runtime.read(cx).quitting)
        {
            return lifecycle_view::quit(lang, window, cx);
        }
        if runtime
            .as_ref()
            .is_some_and(|runtime| runtime.read(cx).legacy)
        {
            return onboarding::legacy::screen(lang, window, cx);
        }
        if self.onboarding.gate == Gate::Pending {
            // The shot harness has no lifecycle: its pending window shows the frame.
            if let Some(runtime) = runtime {
                return runtime.update(cx, |runtime, cx| {
                    lifecycle_view::boot(runtime, lang, window, cx)
                });
            }
        } else if self.onboarding.shows() {
            let view = self.onboarding_view(window, cx);
            return self.onboarding_frame(view, window);
        }
        match self.settings_view.clone() {
            Some(view) => self.settings_frame(view, window),
            None => self.adaptive_frame(window, cx),
        }
    }

    fn adaptive_frame(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let (input, platform) = self.shell_window(window);
        let drawer = input.width <= 640.;
        // `useSidebarAutoCollapse`: a pane beside the chat folds the sidebar when the page gets
        // too narrow; the toggle then peeks instead (`AppShell.tsx` WindowChromeLayer onToggle).
        let auto = !drawer && self.sidebar_auto_collapsed(input.width, cx);
        let open = self.sidebar_open && (drawer || (input.width >= 720. && !auto));
        let peek = SidebarPeek::new("sidebar-peek", !drawer && !open, window, cx);
        let toggle = self.sidebar_toggle(open, auto.then(|| peek.clone()), cx);
        let dismiss = cx.entity().downgrade();
        let width = self.sidebar_width(cx);
        self.frame.open = open;
        let sidebar = self.regions.sidebar.clone().cached(region::fill());
        // The workspace first: the titlebar follows the split it builds.
        let workspace = match self.manage_workspace(window, cx) {
            Some(page) => page,
            None => {
                let conversation = self.regions.conversation.clone().cached(region::fill());
                self.workspace(conversation.into_any_element(), window, cx)
            }
        };
        let title = self.regions.titlebar.clone().cached(region::fill());
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
            .workspace(workspace)
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
        if let Some(title) = self.pending_title.take() {
            window.set_window_title(title);
        }
        self.frame_inputs(window, cx);
        self.feed_composer(window, cx);
        if self.source.is_some()
            && let Some(request) = self.pending_navigation.take()
        {
            self.navigate(request, window, cx);
        }
        if let Some(section) = self.pending_settings.take() {
            self.open_settings(&section, window, cx);
        }
        let frame = self.frame(window, cx);
        let rename = self.render_rename(window, cx);
        let task_graph = self.render_task_graph(window, cx);
        let sidebar_dialog = self.space_dialogs(window, cx);
        let viewer = image_viewer::overlay(window, cx);
        let observer = self.render_observer(window, cx);
        let lang = self.theme.strings.locale.ds_lang();
        let update_choice = lifecycle_view::update_choice(lang, window, cx);
        let ds = Ds::get(cx);
        let root = div()
            .track_focus(&self.focus)
            .key_context("Shell")
            .on_action(cx.listener(Self::toggle_sidebar))
            .on_action(cx.listener(Self::focus_composer))
            .on_action(cx.listener(Self::toggle_palette))
            .on_action(cx.listener(|s, _: &TitlebarBack, w, cx| s.titlebar_back(w, cx)))
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
            .children(viewer)
            .child(rename)
            .children(task_graph)
            .children(observer)
            .children(update_choice)
            .child(self.palette())
            .child(sidebar_dialog)
            .children(crate::ui::manage::library::detail::dialog_host(cx))
            .child(self.manage.canon_trust.clone())
            .child(toast::Toaster::new().offset(ds.len(Length::TitlebarSafeAreaTop)));
        overlay::track(toast::track(focus::track_modality(div())))
            .id("shell-root")
            .size_full()
            .child(root)
    }
}
