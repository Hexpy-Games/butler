//! DS SettingsSection and SettingsPage (SettingsSection.tsx, SettingsPage.tsx, settingsPageLabels.tsx,
//! SettingsSection.module.css): a `FormSection` (titled header, description, actions on its right,
//! one bordered card). The section owns its loading (skeleton rows
//! shaped by kind), error (Notice with Retry) and empty (EmptyLine) states, and the "more" row of
//! a paged list. A page holds only sections, `--settings-section-gap` apart, plus an optional footer.
use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, ClickEvent, Element, ElementId, GlobalElementId, InspectorElementId,
    InteractiveElement as _, IntoElement, LayoutId, ParentElement, Pixels, RenderOnce,
    SharedString, Styled as _, Window, div, point, prelude::FluentBuilder as _, px,
};

use crate::tokens::{Color, Length};
use crate::ui::button::{Button, Size, Variant};
use crate::ui::context::Ds;
use crate::ui::skeleton::{RowsShape, SkeletonRows};

use super::empty_line::EmptyLine;
use super::form_section::FormSection;
use super::notice::{Notice, NoticeTone};

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// Card rhythm and the loading skeleton shape: `FormSectionKind`.
pub use super::form_section::FormSectionKind as SettingsSectionKind;

/// Section-level fetch state; `Ready` renders the children.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SettingsSectionState {
    #[default]
    Ready,
    Loading,
    Error,
    Empty,
}

/// Copy for the section states. Unset fields keep the English defaults (`DEFAULT_LABELS`).
#[derive(Clone, Debug, Default)]
pub struct SettingsSectionLabels {
    loading: Option<SharedString>,
    error: Option<SharedString>,
    retry: Option<SharedString>,
    empty: Option<SharedString>,
}

impl SettingsSectionLabels {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn loading(mut self, text: impl Into<SharedString>) -> Self {
        self.loading = Some(text.into());
        self
    }

    pub fn error(mut self, text: impl Into<SharedString>) -> Self {
        self.error = Some(text.into());
        self
    }

    pub fn retry(mut self, text: impl Into<SharedString>) -> Self {
        self.retry = Some(text.into());
        self
    }

    pub fn empty(mut self, text: impl Into<SharedString>) -> Self {
        self.empty = Some(text.into());
        self
    }

    fn pick(
        &self,
        field: fn(&Self) -> &Option<SharedString>,
        default: &'static str,
    ) -> SharedString {
        field(self).clone().unwrap_or_else(|| default.into())
    }
}

/// The list's last row: loads the next page of rows.
pub struct SettingsSectionMore {
    label: SharedString,
    on_click: Handler,
    busy: bool,
}

impl SettingsSectionMore {
    pub fn new(
        label: impl Into<SharedString>,
        on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            label: label.into(),
            on_click: Rc::new(on_click),
            busy: false,
        }
    }

    /// Disables the row while a page loads.
    pub fn busy(mut self) -> Self {
        self.busy = true;
        self
    }
}

#[derive(IntoElement)]
pub struct SettingsSection {
    id: SharedString,
    title: SharedString,
    kind: SettingsSectionKind,
    description: Option<SharedString>,
    actions: Option<AnyElement>,
    more: Option<SettingsSectionMore>,
    state: SettingsSectionState,
    on_retry: Option<Handler>,
    error_message: Option<SharedString>,
    empty_message: Option<SharedString>,
    holds_fields: bool,
    labels: SettingsSectionLabels,
    children: Vec<AnyElement>,
}

impl SettingsSection {
    /// `id` is stable (settings page schemas list it); `title` names what the card holds and never
    /// repeats the page title.
    pub fn new(
        id: impl Into<SharedString>,
        kind: SettingsSectionKind,
        title: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            kind,
            description: None,
            actions: None,
            more: None,
            state: SettingsSectionState::Ready,
            on_retry: None,
            error_message: None,
            empty_message: None,
            holds_fields: false,
            labels: SettingsSectionLabels::default(),
            children: Vec::new(),
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Header actions (add, refresh, filter, period): outline, size sm, right-aligned; only on
    /// `List` and `Status`. Never a setting.
    pub fn actions(mut self, actions: impl IntoElement) -> Self {
        self.actions = Some(actions.into_any_element());
        self
    }

    /// A "more" last row for paged lists; drawn only while the section is ready.
    pub fn more(mut self, more: SettingsSectionMore) -> Self {
        self.more = Some(more);
        self
    }

    pub fn state(mut self, state: SettingsSectionState) -> Self {
        self.state = state;
        self
    }

    /// Shows a Retry button in the error state.
    pub fn on_retry(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_retry = Some(Rc::new(handler));
        self
    }

    /// Overrides the page's error copy.
    /// Text only (React takes a node; Notice here takes a string).
    pub fn error_message(mut self, message: impl Into<SharedString>) -> Self {
        self.error_message = Some(message.into());
        self
    }

    /// Overrides the page's empty copy.
    pub fn empty_message(mut self, message: impl Into<SharedString>) -> Self {
        self.empty_message = Some(message.into());
        self
    }

    /// The card holds a settings field, so it keeps the field gap whatever its kind (CSS
    /// `:has(> [data-settings-field])`; gpui cannot query its children).
    pub fn holds_fields(mut self) -> Self {
        self.holds_fields = true;
        self
    }

    /// Applied by `SettingsPage` from its labels.
    fn with_labels(mut self, labels: &SettingsSectionLabels) -> Self {
        self.labels = labels.clone();
        self
    }
}

impl ParentElement for SettingsSection {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl SettingsSection {
    /// The card body for the current state; ready children get the list hairlines and the more row.
    fn body(&mut self) -> Vec<AnyElement> {
        let kind = self.kind;
        let labels = &self.labels;
        match self.state {
            SettingsSectionState::Loading => {
                let rows = match kind {
                    SettingsSectionKind::Form | SettingsSectionKind::Status => 2,
                    SettingsSectionKind::List | SettingsSectionKind::Info => 3,
                };
                let shape = if kind == SettingsSectionKind::Form {
                    RowsShape::Field
                } else {
                    RowsShape::List
                };
                vec![
                    SkeletonRows::new(SharedString::from(format!("{}-skeleton", self.id)))
                        .rows(rows)
                        .shape(shape)
                        .into_any_element(),
                ]
            }
            SettingsSectionState::Error => {
                let message = self
                    .error_message
                    .clone()
                    .unwrap_or_else(|| labels.pick(|l| &l.error, "Could not load this section."));
                let mut notice = Notice::new(NoticeTone::Error, message);
                if let Some(retry) = self.on_retry.clone() {
                    notice = notice.action(
                        Button::new(SharedString::from(format!("{}-retry", self.id)))
                            .size(Size::Sm)
                            .variant(Variant::Outline)
                            .text(labels.pick(|l| &l.retry, "Retry"))
                            .on_click(move |event, window, cx| retry(event, window, cx)),
                    );
                }
                vec![notice.into_any_element()]
            }
            SettingsSectionState::Empty => {
                let message = self
                    .empty_message
                    .clone()
                    .unwrap_or_else(|| labels.pick(|l| &l.empty, "Nothing to show yet."));
                vec![EmptyLine::new(message).into_any_element()]
            }
            SettingsSectionState::Ready => {
                let mut rows = std::mem::take(&mut self.children);
                if let Some(more) = self.more.take() {
                    let on_click = more.on_click;
                    rows.push(
                        div()
                            .flex()
                            .justify_center()
                            .child(
                                Button::new(SharedString::from(format!("{}-more", self.id)))
                                    .size(Size::Sm)
                                    .variant(Variant::Ghost)
                                    .text(more.label)
                                    .when(more.busy, Button::disabled)
                                    .on_click(move |event, window, cx| on_click(event, window, cx)),
                            )
                            .into_any_element(),
                    );
                }
                rows
            }
        }
    }
}

impl RenderOnce for SettingsSection {
    fn render(mut self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let rows = self.body();
        let mut section = FormSection::new(self.title).kind(self.kind);
        if let Some(description) = self.description {
            section = section.description(description);
        }
        if let Some(actions) = self.actions {
            section = section.actions(actions);
        }
        if self.holds_fields {
            section = section.holds_field();
        }
        div().id(self.id).w_full().child(section.children(rows))
    }
}

/// A settings page: sections `--settings-section-gap` apart, plus an optional footer that sticks
/// to the bottom of the scroll area showing the page (`.footer { position: sticky; bottom: 0 }`).
#[derive(IntoElement)]
pub struct SettingsPage {
    labels: SettingsSectionLabels,
    footer: Option<AnyElement>,
    sections: Vec<SettingsSection>,
}

impl SettingsPage {
    pub fn new() -> Self {
        Self {
            labels: SettingsSectionLabels::default(),
            footer: None,
            sections: Vec::new(),
        }
    }

    /// Section state copy (loading, error, retry, empty).
    pub fn labels(mut self, labels: SettingsSectionLabels) -> Self {
        self.labels = labels;
        self
    }

    /// The page-wide save / reset bar at the bottom of the detail scroll area.
    pub fn footer(mut self, footer: impl IntoElement) -> Self {
        self.footer = Some(footer.into_any_element());
        self
    }

    /// Only sections can be children of a page.
    pub fn section(mut self, section: SettingsSection) -> Self {
        self.sections.push(section);
        self
    }
}

impl Default for SettingsPage {
    fn default() -> Self {
        Self::new()
    }
}

impl RenderOnce for SettingsPage {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let labels = self.labels;
        div()
            .flex()
            .flex_col()
            .min_w_0()
            .gap(ds.len(Length::SettingsSectionGap))
            .children(
                self.sections
                    .into_iter()
                    .map(|section| section.with_labels(&labels)),
            )
            .children(self.footer.map(|footer| {
                StickyBottom(
                    div()
                        .flex()
                        .justify_end()
                        .py(ds.len(Length::SpaceMd))
                        .border_t(ds.len(Length::BorderHairline))
                        .border_color(ds.color(Color::Line))
                        .bg(ds.color(Color::SettingsBg))
                        .child(footer)
                        .into_any_element(),
                )
            }))
    }
}

/// `position: sticky; bottom: 0`: laid out where it falls, but while that runs past the bottom
/// of the area that clips it (the scroll port), drawn against that bottom edge instead, over the
/// content it covers. It is the page's last child, so it never lifts above the page.
struct StickyBottom(AnyElement);

impl IntoElement for StickyBottom {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for StickyBottom {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        (self.0.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        &mut (): &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let port = window.content_mask().bounds;
        let lift = (bounds.bottom() - port.bottom()).max(px(0.));
        window.with_element_offset(point(px(0.), -lift), |window| {
            self.0.prepaint(window, cx);
        });
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        &mut (): &mut (),
        &mut (): &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.0.paint(window, cx);
    }
}
