//! DS DocumentEditor and DocumentBlockEmbed (DocumentEditor.tsx / DocumentEditor.module.css): the
//! chrome of a document page, a title line with the document actions, one status line, and the
//! page. The caller owns the body: it passes the page's content (MarkdownContent in its
//! document density, block embeds between), so a document reads the same edited as read. On a
//! title line narrower than 30rem the inline actions fold into a "more" menu when the caller
//! gave `menu_actions`; host `controls` (close) stay at every width.
use gpui::{
    AnyElement, App, Div, ElementId, IntoElement, ParentElement, RenderOnce, SharedString,
    Styled as _, Window, div,
};

use super::measure;
use super::overflow_action_menu::{OverflowActionMenu, OverflowItem};
use crate::tokens::{Color, Length};
use crate::ui::context::Ds;

/// `@container document-title (width < 30rem)` (rem is 16px).
const NARROW: f32 = 480.; // DS: DocumentEditor.module.css:83

#[derive(IntoElement)]
pub struct DocumentEditor {
    id: SharedString,
    title: Option<AnyElement>,
    note: Option<AnyElement>,
    actions: Option<AnyElement>,
    menu_actions: Vec<OverflowItem>,
    menu_label: SharedString,
    controls: Option<AnyElement>,
    format_bar: Option<AnyElement>,
    children: Vec<AnyElement>,
}

impl DocumentEditor {
    pub fn new(id: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: None,
            note: None,
            actions: None,
            menu_actions: Vec::new(),
            menu_label: "More".into(),
            controls: None,
            format_bar: None,
            children: Vec::new(),
        }
    }

    /// The document's title (a name field or a heading), centred on the control line it shares
    /// with the actions. Leave it out when a surrounding dialog header already shows it.
    pub fn title(mut self, title: impl IntoElement) -> Self {
        self.title = Some(title.into_any_element());
        self
    }

    /// One status line under the title: "버틀러가 수정 중", the saved time.
    pub fn note(mut self, note: impl IntoElement) -> Self {
        self.note = Some(note.into_any_element());
        self
    }

    /// Document actions at the end of the title line, inline wherever the line has room.
    pub fn actions(mut self, actions: impl IntoElement) -> Self {
        self.actions = Some(actions.into_any_element());
        self
    }

    /// The same actions as flat menu items: on a narrow title line they replace `actions`, so
    /// the title keeps the width.
    // CARVE-OUT(G-ds): React's `menuRef` (anchoring a popover an item opens to the ⋯ trigger)
    // has no counterpart; OverflowActionMenu exposes no trigger bounds.
    pub fn menu_actions(mut self, items: impl IntoIterator<Item = OverflowItem>) -> Self {
        self.menu_actions = items.into_iter().collect();
        self
    }

    /// The ⋯ trigger's accessible name.
    pub fn menu_label(mut self, label: impl Into<SharedString>) -> Self {
        self.menu_label = label.into();
        self
    }

    /// Host controls after the actions (close), visible at every width.
    pub fn controls(mut self, controls: impl IntoElement) -> Self {
        self.controls = Some(controls.into_any_element());
        self
    }

    /// The floating format bar, rendered over the page.
    // CARVE-OUT(G-doc-edit): DocumentFormatBar itself is P4b; this slot only places it.
    pub fn format_bar(mut self, bar: impl IntoElement) -> Self {
        self.format_bar = Some(bar.into_any_element());
        self
    }
}

impl ParentElement for DocumentEditor {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// The status line: the caption in the secondary tone.
fn status(note: AnyElement, ds: &Ds) -> Div {
    div()
        .text_size(ds.len(Length::TypoCaptionSize))
        .line_height(ds.len(Length::TypoCaptionLineHeight))
        .text_color(ds.color(Color::TextSecondary))
        .child(note)
}

impl RenderOnce for DocumentEditor {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (size, recorder) =
            measure::track((ElementId::from(self.id.clone()), "header"), window, cx);
        let ds = Ds::get(cx);
        let narrow = size.width > gpui::px(0.) && f32::from(size.width) < NARROW;
        let folds = !self.menu_actions.is_empty();
        let ends = self.actions.is_some() || self.controls.is_some();
        let note = self.note.map(|note| status(note, ds));
        let header = if self.title.is_some() || ends {
            // The line is one control tall, rising to the touch target where controls grow to it.
            let line = ds
                .len(Length::ControlHeightMd)
                .max(ds.len(Length::ControlHitTarget));
            let mut trailing = div()
                .flex()
                .flex_none()
                .items_center()
                .gap(ds.len(Length::SpaceXs));
            if folds && narrow {
                let menu =
                    OverflowActionMenu::new(format!("{}-menu", self.id), self.menu_label.clone())
                        .items(self.menu_actions);
                trailing = trailing.child(div().flex().child(menu));
            } else {
                trailing = trailing.children(self.actions);
            }
            trailing = trailing.children(self.controls);
            let top = div()
                .flex()
                .items_center()
                .gap_x(ds.len(Length::SpaceMd))
                .min_h(line)
                .child(div().flex_1().min_w_0().children(self.title))
                .children(ends.then_some(trailing));
            Some(
                div()
                    .relative()
                    .flex()
                    .flex_col()
                    .min_w_0()
                    .gap_y(ds.len(Length::SpaceXs))
                    .child(recorder)
                    .child(top)
                    .children(note),
            )
        } else {
            None
        };
        let page = div().flex().flex_col().min_w_0().children(self.children);
        let body = div()
            .relative()
            .flex()
            .flex_col()
            .w_full()
            .min_w_0()
            .gap(ds.len(Length::SpaceLg));
        let body = match header {
            Some(header) => body.child(header),
            None => body,
        };
        body.child(page).children(self.format_bar)
    }
}

/// A block inside the document text: not editable as text, selectable and movable as one unit.
#[derive(IntoElement)]
pub struct DocumentBlockEmbed {
    selected: bool,
    children: Vec<AnyElement>,
}

impl DocumentBlockEmbed {
    pub fn new() -> Self {
        Self {
            selected: false,
            children: Vec::new(),
        }
    }

    /// Selected as one unit in the text (arrow keys, click): an outline.
    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }
}

impl Default for DocumentBlockEmbed {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for DocumentBlockEmbed {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for DocumentBlockEmbed {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        // `outline: 2px solid` at an offset of `--space-xs`, drawn as a ring around the block.
        // ANIM-MIGRATE(the outline colour fades in over `--motion-fast`)
        let reach = ds.len(Length::SpaceXs) + ds.len(Length::BorderWidthStrong);
        let outline = self.selected.then(|| {
            div()
                .absolute()
                .top(-reach)
                .right(-reach)
                .bottom(-reach)
                .left(-reach)
                .rounded(ds.len(Length::RadiusControl) + reach)
                .border(ds.len(Length::BorderWidthStrong))
                .border_color(ds.color(Color::Accent))
        });
        div()
            .relative()
            .my(ds.len(Length::SpaceMd))
            .rounded(ds.len(Length::RadiusControl))
            .children(self.children)
            .children(outline)
    }
}
