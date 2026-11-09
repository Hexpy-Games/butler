//! DS VersionHistory (VersionHistory.tsx / VersionHistory.module.css): a document's versions,
//! newest first, one dense row each (who made it, the word "current" on the first, the time at
//! the end) over a footer with the restore action. Picking a row previews that version.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _,
    Window, div, linear_color_stop, linear_gradient,
};

use crate::tokens::{Color, Length};
use crate::ui::clickable::{Clickable, Variant};
use crate::ui::context::Ds;
use crate::ui::typo::{Tone, Typo, Weight, Wrap};

type Select = Rc<dyn Fn(SharedString, &mut Window, &mut App)>;

/// Who made a version: the person (neutral dot) or Butler (the Butler inks).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Author {
    User,
    Butler,
}

#[derive(Clone, Debug)]
pub struct VersionHistoryEntry {
    pub id: SharedString,
    pub author: Author,
    /// The author's name as shown: "나", "버틀러".
    pub author_label: SharedString,
    /// When, formatted for the locale ("오후 3:12", "어제").
    pub time: SharedString,
    /// The machine-readable time (`dateTime`). gpui has no `time` element, so nothing reads it.
    pub date_time: Option<SharedString>,
}

#[derive(IntoElement)]
pub struct VersionHistory {
    id: ElementId,
    current_label: SharedString,
    entries: Vec<VersionHistoryEntry>,
    selected_id: Option<SharedString>,
    on_select: Option<Select>,
    action: Option<AnyElement>,
}

impl VersionHistory {
    /// `label` names the list for assistive tech, which gpui has no tree for; it is accepted so
    /// callers keep React's argument list. `current_label` is the word on the first row ("현재").
    pub fn new(
        id: impl Into<ElementId>,
        _label: impl Into<SharedString>,
        current_label: impl Into<SharedString>,
        entries: Vec<VersionHistoryEntry>,
    ) -> Self {
        Self {
            id: id.into(),
            current_label: current_label.into(),
            entries,
            selected_id: None,
            on_select: None,
            action: None,
        }
    }

    /// The version being previewed.
    pub fn selected_id(mut self, id: impl Into<SharedString>) -> Self {
        self.selected_id = Some(id.into());
        self
    }

    pub fn on_select(
        mut self,
        handler: impl Fn(SharedString, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_select = Some(Rc::new(handler));
        self
    }

    /// The footer action for the selected version (Restore); absent while the current one is.
    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.action = Some(action.into_any_element());
        self
    }
}

/// The author's mark: a neutral dot for the person, the Butler inks for Butler.
fn mark(author: Author, ds: &Ds) -> gpui::Div {
    let dot = div()
        .flex_none()
        .size(ds.len(Length::SpaceSm))
        .rounded(ds.len(Length::RadiusPill));
    match author {
        Author::User => dot.bg(ds.color(Color::TextTertiary)),
        // DS: VersionHistory.module.css:42 has the purple ink at 55%; gpui gradients take two
        // stops, so the mark runs blue to pink as the IconButton indicator does.
        Author::Butler => dot.bg(linear_gradient(
            135.,
            linear_color_stop(ds.color(Color::ButlerInkBlue), 0.),
            linear_color_stop(ds.color(Color::ButlerInkPink), 1.),
        )),
    }
}

fn row(
    list: &ElementId,
    entry: VersionHistoryEntry,
    current: Option<SharedString>,
    selected: bool,
    on_select: Option<Select>,
    ds: &Ds,
) -> AnyElement {
    let weight = (entry.author == Author::Butler).then_some(Weight::Semibold);
    let mut label = Typo::label(entry.author_label).truncate();
    if let Some(weight) = weight {
        label = label.weight(weight);
    }
    let line = div()
        .flex()
        .items_center()
        .gap(ds.len(Length::SpaceSm))
        .w_full()
        .min_w_0()
        .p(ds.len(Length::SpaceSm))
        .rounded(ds.len(Length::RadiusControl))
        .child(mark(entry.author, ds))
        .child(label)
        .children(current.map(|word| Typo::caption(word).tone(Tone::Secondary)))
        .child(
            div().flex().flex_1().min_w_0().justify_end().child(
                Typo::caption(entry.time)
                    .tone(Tone::Tertiary)
                    .tabular()
                    .wrap(Wrap::Nowrap),
            ),
        );
    let line = if selected {
        line.bg(ds.color(Color::Selection))
    } else {
        line
    };
    let id = entry.id;
    Clickable::new((list.clone(), id.clone()))
        .variant(Variant::Text)
        .stretch()
        .on_click(move |_, window, cx| {
            if let Some(select) = &on_select {
                select(id.clone(), window, cx);
            }
        })
        .child(line)
        .into_any_element()
}

impl RenderOnce for VersionHistory {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let rows = self.entries.into_iter().enumerate().map(|(index, entry)| {
            let selected = self.selected_id.as_ref() == Some(&entry.id);
            let current = (index == 0).then(|| self.current_label.clone());
            row(
                &self.id,
                entry,
                current,
                selected,
                self.on_select.clone(),
                ds,
            )
        });
        let footer = self.action.map(|action| {
            div()
                .flex()
                .justify_end()
                .px(ds.len(Length::SpaceSm))
                .child(action)
        });
        div()
            .flex()
            .flex_col()
            .gap(ds.len(Length::SpaceSm))
            // `min-width: min(20rem, 100%)`: the host (a popover, 18rem) is narrower than 20rem,
            // so the list is as wide as the host and the time at the row's end stays inside it.
            .w_full() // DS: VersionHistory.module.css:5
            .child(div().flex().flex_col().children(rows))
            .children(footer)
    }
}
