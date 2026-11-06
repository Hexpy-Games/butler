//! The DS View window: a sidebar of showcase pages and the selected page.
use std::borrow::Cow;

use butler_ds::tokens::{Color, GradientToken, Length, TokenContext};
use butler_ds::ui::context::{Ds, Lang as DsLang, Platform};
use butler_ds::ui::convert;
use butler_ds::ui::focus;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, App, Context, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, SharedString, StatefulInteractiveElement as _, Styled as _, TextRenderingMode, Window,
    div, prelude::*, px,
};

use crate::copy::Lang;
use crate::pages::{self, Page};

/// Loads the bundled faces; the DS View draws grayscale text like the shell.
pub(crate) fn init(cx: &mut App) -> anyhow::Result<()> {
    cx.set_text_rendering_mode(TextRenderingMode::Grayscale);
    cx.text_system().add_fonts(
        butler_ds::ui::assets::FONTS
            .iter()
            .map(|bytes| Cow::Borrowed(*bytes))
            .collect(),
    )?;
    Ok(())
}

/// Installs the `Ds` global for a theme and showcase language. Called once per window.
pub(crate) fn install(cx: &mut App, dark: bool, lang: Lang) {
    let tokens = TokenContext {
        dark,
        ..TokenContext::DEFAULT
    };
    let mut ds = Ds::new(tokens, Platform::Mac);
    ds.detect_fonts(&cx.text_system().all_font_names());
    ds.set_lang(match lang {
        Lang::En => DsLang::En,
        Lang::Ko => DsLang::Ko,
    });
    ds.install(cx);
}

pub(crate) struct DsView {
    pages: Vec<Page>,
    page: usize,
    pub(crate) lang: Lang,
}

impl DsView {
    pub(crate) fn new(window: &Window, _: &mut Context<Self>) -> Self {
        let _ = window;
        Self {
            pages: pages::all(),
            page: 0,
            lang: Lang::Ko,
        }
    }

    pub(crate) fn open(&mut self, page: usize, cx: &mut Context<Self>) {
        self.page = page.min(self.pages.len().saturating_sub(1));
        cx.notify();
    }

    /// The story names of the open page.
    #[cfg(feature = "shots")]
    pub(crate) fn story_names(&self) -> Vec<String> {
        self.pages
            .get(self.page)
            .map(|page| {
                (page.stories)()
                    .iter()
                    .map(|story| story.name.to_owned())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn sidebar(&self, cx: &mut Context<Self>) -> AnyElement {
        let ds = Ds::get(cx);
        let items = self.pages.iter().enumerate().map(|(index, page)| {
            let selected = index == self.page;
            let row = div()
                .id(SharedString::from(format!("nav-{}", page.id)))
                .h(ds.len(Length::ControlHeightSm))
                .px(ds.len(Length::SpaceSm))
                .flex()
                .items_center()
                .rounded(ds.len(Length::RadiusControl))
                .cursor_pointer()
                .when(selected, |row| row.bg(ds.color(Color::Selection)))
                .on_click(cx.listener(move |view, _, _, cx| view.open(index, cx)))
                .child(
                    Typo::label(page.title)
                        .weight(butler_ds::ui::typo::Weight::Medium)
                        .tone(if selected {
                            Tone::Primary
                        } else {
                            Tone::Secondary
                        }),
                );
            row.into_any_element()
        });
        div()
            .w(px(SIDEBAR_WIDTH))
            .flex_none()
            .h_full()
            .flex()
            .flex_col()
            .gap(px(2.))
            .p(ds.len(Length::SpaceMd))
            .border_r(ds.len(Length::BorderHairline))
            .border_color(ds.color(Color::Line))
            .bg(ds.color(Color::Surface))
            .children(items)
            .into_any_element()
    }
}

/// The sidebar's width; the DS View's own chrome, not a DS value.
const SIDEBAR_WIDTH: f32 = 220.;
/// The window width at or below which the DS View drops its sidebar.
const COMPACT_WINDOW: f32 = 640.;

impl Render for DsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        butler_ds::ui::control::reset_anchors(cx);
        butler_ds::ui::tooltip::reset_shown(cx);
        let size = window.viewport_size();
        // The mobile ramp (`width <= 640`) hides the sidebar, as the viewer's nav drawer does.
        let narrow = f32::from(size.width) <= COMPACT_WINDOW;
        let content = if narrow {
            size.width
        } else {
            size.width - px(SIDEBAR_WIDTH)
        };
        Ds::update(cx, |ds| {
            ds.set_viewport(f32::from(content), f32::from(size.height));
        });
        let lang = self.lang;
        let page = self
            .pages
            .get(self.page)
            .map(|page| (page.title, (page.stories)()));
        let body = match page {
            Some((title, stories)) => pages::page(title, stories, lang, window, cx),
            None => div().into_any_element(),
        };
        let ds = Ds::get(cx);
        // The viewer's layers: the shell material over the browser canvas, then the workspace.
        let shell = ds.color(Color::SidebarBg);
        let workspace = ds.color(Color::WorkspaceBg);
        let root = div()
            .size_full()
            .bg(gpui::white()) // Chromium's default canvas under the viewer
            .child(
                div()
                    .size_full()
                    .flex()
                    .flex_row()
                    .bg(shell)
                    .text_color(ds.color(Color::TextPrimary))
                    .font_family(ds.body_font().clone())
                    .text_size(ds.len(Length::TypoBodySize)) // the viewer's body: 14px / 20px
                    .line_height(ds.len(Length::TypoBodyLineHeight))
                    .font_weight(FontWeight::NORMAL)
                    .when(!narrow, |root| root.child(self.sidebar(cx)))
                    .child(
                        div()
                            .id("page")
                            .flex_1()
                            .min_w_0()
                            .h_full()
                            .overflow_y_scroll()
                            .bg(workspace)
                            .child(crate::pages::anchored(body, "page-content")),
                    ),
            );
        focus::track_modality(root)
    }
}

/// The story frame's background, `--conversation-bg`.
pub(crate) fn conversation_bg(ds: &Ds) -> gpui::Background {
    convert::gradient(ds.tokens().gradient(GradientToken::ConversationBg))
}
