//! DS SettingsSecretRows (SettingsSecretRows.tsx / SettingsSecretRows.module.css): the compact
//! layout of an editable secret map in settings. A header (the title, and a toolbar of bulk
//! actions at the end) over one row per secret: source, key, value and a row action. The block
//! owns geometry only; the controls come in as slots. A native select in the toolbar or the
//! source slot takes `.stretch()` and sits in [`source_cell`], which gives it the 116px column
//! (the CSS reaches into the select's wrapper; a gpui select cannot be restyled from outside).
//! The block stacks by its own width (`container-type: inline-size`), not the window's.
use gpui::{
    AnyElement, App, Div, ElementId, IntoElement, ParentElement as _, RenderOnce, SharedString,
    Styled as _, Window, div, px,
};

use crate::tokens::Length;
use crate::ui::blocks::measure;
use crate::ui::context::Ds;
use crate::ui::typo::Typo;

/// The source column.
const SOURCE_WIDTH: f32 = 116.; // DS: SettingsSecretRows.module.css:37
/// The narrowest source column once stacked.
const SOURCE_MIN: f32 = 92.; // DS: SettingsSecretRows.module.css:72
/// The key and value column minimums and their `fr` shares.
const KEY_MIN: f32 = 120.; // DS: SettingsSecretRows.module.css:37
const KEY_FR: f32 = 0.8; // DS: SettingsSecretRows.module.css:37
const VALUE_MIN: f32 = 160.; // DS: SettingsSecretRows.module.css:37
const VALUE_FR: f32 = 1.2; // DS: SettingsSecretRows.module.css:37
/// The block stacks at or below this width (`@container (width <= 30rem)`, rem = 16px).
const STACK_AT: f32 = 480.; // DS: SettingsSecretRows.module.css:62

/// A native select (or any control) in the 116px source column, for the toolbar or a row's
/// source slot. Give a select `.stretch()` so it fills the column.
pub fn source_cell(child: impl IntoElement) -> Div {
    column().w(px(SOURCE_WIDTH)).child(child)
}

fn column() -> Div {
    div().flex().flex_col().min_w_0()
}

/// One secret: source, key, value and a row action (`SettingsSecretRow`).
#[derive(IntoElement)]
pub struct SettingsSecretRow {
    source: AnyElement,
    key: AnyElement,
    value: AnyElement,
    action: AnyElement,
    stacked: bool,
}

impl SettingsSecretRow {
    pub fn new(
        source_control: impl IntoElement,
        key_control: impl IntoElement,
        value_control: impl IntoElement,
        action_control: impl IntoElement,
    ) -> Self {
        Self {
            source: source_control.into_any_element(),
            key: key_control.into_any_element(),
            value: value_control.into_any_element(),
            action: action_control.into_any_element(),
            stacked: false,
        }
    }

    /// The rows of a narrow block: source and key on the first line, the value under them, the
    /// action at the end of the first line.
    fn stacked(mut self, on: bool) -> Self {
        self.stacked = on;
        self
    }
}

/// A column that takes `share` of the free width (`<share>fr`) but never less than `min`.
fn grow(cell: Div, share: f32, min: f32) -> Div {
    let mut cell = cell.flex_1().min_w(px(min));
    cell.style().flex_grow = Some(share);
    cell
}

impl RenderOnce for SettingsSecretRow {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let gap = ds.len(Length::Space2);
        if !self.stacked {
            return div()
                .flex()
                .items_center()
                .min_w_0()
                .gap(gap)
                .child(column().w(px(SOURCE_WIDTH)).flex_none().child(self.source))
                .child(grow(column().child(self.key), KEY_FR, KEY_MIN))
                .child(grow(column().child(self.value), VALUE_FR, VALUE_MIN))
                .child(column().flex_none().child(self.action));
        }
        let first = div()
            .flex()
            .items_center()
            .min_w_0()
            .gap(gap)
            .child(
                column()
                    .w(px(SOURCE_WIDTH))
                    .min_w(px(SOURCE_MIN))
                    .child(self.source),
            )
            .child(column().flex_1().child(self.key));
        // The action sits in the first line: it is centred on a control-height line.
        let action = div()
            .flex()
            .items_center()
            .flex_none()
            .h(ds.len(Length::ControlHeightMd))
            .child(self.action);
        div()
            .flex()
            .items_start()
            .min_w_0()
            .gap(gap)
            .child(
                column()
                    .flex_1()
                    .gap(gap)
                    .child(first)
                    .child(column().child(self.value)),
            )
            .child(action)
    }
}

/// The titled block (`SettingsSecretRows`): a title with its toolbar, the rows and an optional
/// empty-state line.
#[derive(IntoElement)]
pub struct SettingsSecretRows {
    id: ElementId,
    title: SharedString,
    actions: Vec<AnyElement>,
    empty_state: Option<SharedString>,
    rows: Vec<SettingsSecretRow>,
}

impl SettingsSecretRows {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            actions: Vec::new(),
            empty_state: None,
            rows: Vec::new(),
        }
    }

    /// A toolbar control at the header's end (a default-source select, bulk buttons).
    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.actions.push(action.into_any_element());
        self
    }

    /// The line under the rows (shown when there are none).
    pub fn empty_state(mut self, text: impl Into<SharedString>) -> Self {
        self.empty_state = Some(text.into());
        self
    }

    pub fn row(mut self, row: SettingsSecretRow) -> Self {
        self.rows.push(row);
        self
    }

    pub fn rows(mut self, rows: impl IntoIterator<Item = SettingsSecretRow>) -> Self {
        self.rows.extend(rows);
        self
    }
}

impl RenderOnce for SettingsSecretRows {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (size, recorder) = measure::track(self.id.clone(), window, cx);
        let ds = Ds::get(cx);
        let gap = ds.len(Length::Space2);
        // Zero is "not measured yet": lay out wide rather than flash the stacked form.
        let width = f32::from(size.width);
        let stacked = width > 0. && width <= STACK_AT;
        let mut toolbar = div().flex().flex_wrap().min_w_0().gap(gap);
        if !stacked {
            toolbar = toolbar.justify_end();
        }
        let toolbar = (!self.actions.is_empty()).then(|| toolbar.children(self.actions));
        let title = column().flex_1().child(Typo::body(self.title));
        let header = if stacked {
            div()
                .flex()
                .flex_col()
                .gap(gap)
                .child(title)
                .children(toolbar)
        } else {
            div()
                .flex()
                .items_center()
                .gap(gap)
                .child(title)
                .children(toolbar)
        };
        let rows = self.rows.into_iter().map(|row| row.stacked(stacked));
        let empty = self
            .empty_state
            .map(|text| column().child(Typo::caption(text)));
        div()
            .relative()
            .flex()
            .flex_col()
            .w_full()
            .min_w_0()
            .gap(gap)
            .child(recorder)
            .child(header)
            .child(column().gap(gap).children(rows))
            .children(empty)
    }
}
