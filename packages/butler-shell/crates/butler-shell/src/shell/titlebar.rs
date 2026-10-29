//! The title row (blocks/TitlebarShell, components/layout/Titlebar.tsx, WindowControls.tsx):
//! 48px, title at 18px (56px from the window edge with the sidebar collapsed), trailing
//! icon buttons, then the app-drawn window controls 10px from the edge.
use gpui::{
    AnimationExt as _, AnyElement, Context, FontWeight, SharedString, WindowControlArea, div,
    prelude::*, px,
};

use super::{Shell, ToggleTheme};
use crate::motion::spring_slow;
use crate::sidebar::TRACK_MIN;
use crate::theme::typo;
use crate::widgets::{IconButtonSpec, hover_listener, icon_button, text};

impl Shell {
    /// The open chat's title and, for a project chat, the project's name.
    fn title_copy(&self) -> (SharedString, Option<SharedString>) {
        let chat = self
            .selected
            .as_ref()
            .and_then(|id| self.chats.iter().find(|c| &c.id == id));
        match chat {
            None => ("새 대화".into(), None),
            Some(chat) => {
                let project = chat
                    .space
                    .as_ref()
                    .filter(|s| s.project)
                    .map(|s| s.title.clone());
                (chat.title.clone(), project)
            }
        }
    }

    fn window_controls(&mut self, cx: &mut Context<Self>) -> gpui::Div {
        let t = self.theme.clone();
        let mut controls = div()
            .absolute()
            .right(px(10.))
            .top(px(9.))
            .flex()
            .items_center()
            .gap(px(8.));
        for (id, glyph, area, glyph_size) in [
            ("wc-min", "minus", WindowControlArea::Min, 16.),
            ("wc-max", "square", WindowControlArea::Max, 14.),
            ("wc-close", "x", WindowControlArea::Close, 16.),
        ] {
            let key: SharedString = id.into();
            let mut spec = IconButtonSpec::new(id, glyph, self.hover.is(id)).size(30., glyph_size);
            spec.control = Some(area);
            controls = controls.child(icon_button(
                &t,
                spec,
                hover_listener(&key, cx),
                |_, _, _| {},
            ));
        }
        controls
    }

    pub(super) fn render_titlebar(
        &mut self,
        sidebar_open: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = self.theme.clone();
        let (title, subtitle) = self.title_copy();
        let identity = div()
            .flex()
            .flex_1()
            .min_w_0()
            .items_baseline()
            .gap(px(8.))
            .child(text(title, typo::APP_TITLE, FontWeight::SEMIBOLD, t.text).truncate())
            .children(
                subtitle
                    .map(|sub| text(sub, typo::CAPTION, FontWeight::NORMAL, t.text3).truncate()),
            );
        let theme_glyph = if t.dark { "sun" } else { "moon" };
        let theme_spec = IconButtonSpec::new("tb-theme", theme_glyph, self.hover.is("tb-theme"));
        let theme_click =
            cx.listener(|_, _, window, cx| window.dispatch_action(Box::new(ToggleTheme), cx));
        let more_spec = IconButtonSpec::new("tb-more", "more", self.hover.is("tb-more"))
            .disabled(Some(crate::sidebar::NOT_YET.into()));
        let trailing = div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(8.))
            .child(icon_button(
                &t,
                theme_spec,
                hover_listener(&"tb-theme".into(), cx),
                theme_click,
            ))
            .child(icon_button(
                &t,
                more_spec,
                hover_listener(&"tb-more".into(), cx),
                |_, _, _| {},
            ));
        let controls = self.window_controls(cx);
        // The collapsed-sidebar inset (56px from the window edge) minus the collapsed track.
        let collapsed_pad = 56. - TRACK_MIN - 1.;
        div()
            .id("titlebar")
            .absolute()
            .top_0()
            .left_0()
            .right_0()
            .h(px(48.))
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .pr(px(18. + 138.))
            .window_control_area(WindowControlArea::Drag)
            .child(identity)
            .child(trailing)
            .child(controls)
            .with_spring("titlebar-pad", spring_slow(sidebar_open), move |el, v| {
                el.pl(px(collapsed_pad + (18. - collapsed_pad) * v))
            })
            .into_any_element()
    }
}
