//! `file-viewer/FileViewerFrame`: the open file's title row and its page.
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::measure;
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Box, Cross, MinWidth, Space, Stack, WithItem as _};
use butler_ds::ui::scroll::ScrollArea;
use butler_ds::ui::separator::Separator;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement, ParentElement as _, RenderOnce,
    SharedString, Styled as _, Window, div, px,
};

use crate::ui::i18n::file_viewer::FileViewerStrings;

pub(crate) type Run = Rc<dyn Fn(&mut Window, &mut App)>;

/// Below this header width the actions show as icons (with tooltips) so name, actions and close
/// keep one row (`COMPACT_HEADER_WIDTH`).
const COMPACT_HEADER_WIDTH: f32 = 480.;

/// `FileViewerAction`.
pub(crate) struct FileViewerAction {
    pub(crate) id: &'static str,
    pub(crate) label: SharedString,
    pub(crate) icon: Icon,
    /// Show the icon beside the label in the wide header too.
    pub(crate) label_icon: bool,
    /// Keep this action an icon button at every header width.
    pub(crate) icon_only: bool,
    pub(crate) run: Run,
}

/// `FileViewerHeader`: the open file's name and "size · time" (both truncate), then its actions
/// and close, which never wrap. In a narrow pane the actions are icon buttons with tooltips.
#[derive(IntoElement)]
pub(crate) struct FileViewerHeader {
    pub(crate) title: SharedString,
    pub(crate) meta: Option<SharedString>,
    pub(crate) leading: Option<AnyElement>,
    pub(crate) actions: Vec<FileViewerAction>,
    pub(crate) on_close: Run,
    /// Back to the chat (the viewer took the whole workspace).
    pub(crate) on_back: Option<Run>,
}

impl RenderOnce for FileViewerHeader {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (size, recorder) = measure::track("file-viewer-header", window, cx);
        let width = f32::from(size.width);
        let compact = width > 0. && width < COMPACT_HEADER_WIDTH;
        let ds = Ds::get(cx);
        let mut buttons = button::container(if compact { Size::IconSm } else { Size::Sm })
            .wrap(false)
            .cross(Cross::Center);
        for action in self.actions {
            let run = action.run;
            buttons = buttons.child(if compact || action.icon_only {
                IconButton::new(format!("file-viewer-{}", action.id), action.label)
                    .glyph(action.icon)
                    .on_click(move |_, window, cx| run(window, cx))
                    .into_any_element()
            } else {
                let mut button = Button::new(format!("file-viewer-{}", action.id))
                    .variant(Variant::Outline)
                    .size(Size::Sm)
                    .text(action.label)
                    .on_click(move |_, window, cx| run(window, cx));
                if action.label_icon {
                    button = button.icon_start(icon(action.icon, IconSize::Md, ds));
                }
                button.into_any_element()
            });
        }
        buttons = buttons.child(file_viewer_close_button(self.on_close, cx));
        let mut text = Stack::new()
            .gap(Space::None)
            .grow()
            .min_width(MinWidth::Zero)
            .child(Typo::panel_title(self.title).tone(Tone::Primary).truncate());
        if let Some(meta) = self.meta.filter(|meta| !meta.is_empty()) {
            text = text.child(Typo::caption(meta).tone(Tone::Secondary).truncate());
        }
        let row = Stack::row()
            .cross(Cross::Center)
            .gap(Space::Md)
            .wrap(false)
            .children(self.on_back.map(|back| file_viewer_back_button(back, cx)))
            .child(text)
            .children(self.leading)
            .child(buttons);
        crate::ui::widgets::anchor(
            div().id("file-viewer-header").relative(),
            "file-viewer-header",
        )
        .child(recorder)
        .child(
            Box::new()
                .padding_x(Space::Xxl)
                .padding_y(Space::Md)
                .child(row),
        )
        .child(Separator::new().space(Space::None))
    }
}

/// `FileViewerBackButton`: back to the chat, at the start of the title row.
pub(crate) fn file_viewer_back_button(on_back: Run, cx: &App) -> IconButton {
    IconButton::new("file-viewer-back", FileViewerStrings::get(cx).back_to_chat)
        .glyph(Icon::ArrowLeft)
        .on_click(move |_, window, cx| on_back(window, cx))
}

/// `FileViewerCloseButton`: closes the open file, at the end of its title row.
pub(crate) fn file_viewer_close_button(on_close: Run, cx: &App) -> IconButton {
    IconButton::new("file-viewer-close", FileViewerStrings::get(cx).close)
        .glyph(Icon::X)
        .on_click(move |_, window, cx| on_close(window, cx))
}

/// `FileViewerPage`: the file in the pane's one scroll. Documents fill the pane up to 1400px,
/// centred beyond; other files keep the 760px reading page; both keep side gutters and page-end
/// spacing.
#[derive(IntoElement)]
pub(crate) struct FileViewerPage {
    children: Vec<AnyElement>,
    fill: bool,
}

impl FileViewerPage {
    pub(crate) fn new(fill: bool) -> Self {
        Self {
            children: Vec::new(),
            fill,
        }
    }
}

impl gpui::ParentElement for FileViewerPage {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for FileViewerPage {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        // DS: PageContainer width="document" 1400px, "narrow" 760px.
        let max = if self.fill { 1400. } else { 760. };
        let body = Box::new()
            .padding_y(Space::Xxl)
            .child(Box::new().padding(Space::Xxl).children(self.children));
        crate::ui::widgets::anchor(div().id("file-viewer-page").size_full(), "file-viewer-page")
            .child(
                ScrollArea::new("file-viewer-scroll").fill().child(
                    div()
                        .w_full()
                        .max_w(px(max))
                        .mx_auto()
                        .px(Space::Xxl.px(ds))
                        .child(body),
                ),
            )
    }
}
