//! DS DisclosureRow (DisclosureRow.tsx / DisclosureRow.module.css): a row that reveals detail
//! content below it. One first line, `[icon] title [count] [chevron]` then the meta at the end,
//! a description and a bar under it, and a Collapsible panel indented under the title. Only a
//! row with something to reveal (children, a count above 0, or `reveals`) is a button; any
//! other row is static, with the same columns. The chevron follows the title and turns down
//! when the row opens.
mod parts;

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, Div, ElementId, IntoElement, ParentElement, RenderOnce,
    SharedString, Styled as _, Window, div, px,
};

use self::parts::{Layout, line};
use crate::tokens::{Color, Length};
use crate::ui::clickable::{Bleed, Clickable};
use crate::ui::collapsible::Collapsible;
use crate::ui::context::Ds;
use crate::ui::layout::{Space, Stack};
use crate::ui::typo::{Tone, Typo};

type Toggle = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// `surface`: `selection` fills while open; `plain` sits flush with the text around it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Surface {
    #[default]
    Selection,
    Plain,
}

/// Where the open cue sits: a chevron right after the title, or none (the row is the cue).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Affordance {
    #[default]
    Trailing,
    None,
}

/// A problem row: a dot before the title in the trace error or wait colour.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attention {
    Error,
    Warning,
}

#[derive(IntoElement)]
pub struct DisclosureRow {
    id: ElementId,
    title: SharedString,
    description: Option<SharedString>,
    meta: Option<AnyElement>,
    icon: Option<AnyElement>,
    surface: Surface,
    affordance: Affordance,
    count: Option<u32>,
    reveals: bool,
    attention: Option<Attention>,
    bar: Option<AnyElement>,
    open: bool,
    indent: Option<(u32, Option<SharedString>)>,
    on_toggle: Option<Toggle>,
    children: Vec<AnyElement>,
}

impl DisclosureRow {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            description: None,
            meta: None,
            icon: None,
            surface: Surface::Selection,
            affordance: Affordance::Trailing,
            count: None,
            reveals: false,
            attention: None,
            bar: None,
            open: false,
            indent: None,
            on_toggle: None,
            children: Vec::new(),
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Text at the end of the first line (complete: it wraps, never truncates).
    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        let meta: SharedString = meta.into();
        self.meta = Some(Typo::caption(meta).tone(Tone::Tertiary).into_any_element());
        self
    }

    /// A meta that is an element (tags with a duration), in the caption style.
    pub fn meta_element(mut self, meta: impl IntoElement) -> Self {
        self.meta = Some(meta.into_any_element());
        self
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    pub fn surface(mut self, surface: Surface) -> Self {
        self.surface = surface;
        self
    }

    pub fn affordance(mut self, affordance: Affordance) -> Self {
        self.affordance = affordance;
        self
    }

    /// A muted count after the title: the direct child rows shown while the row is open. A
    /// count above 0 makes the row interactive even without children.
    pub fn count(mut self, count: u32) -> Self {
        self.count = Some(count);
        self
    }

    /// The row toggles content outside it (sibling sections, a region the caller renders).
    pub fn reveals(mut self) -> Self {
        self.reveals = true;
        self
    }

    pub fn attention(mut self, attention: Attention) -> Self {
        self.attention = Some(attention);
        self
    }

    /// A full-width line under the description (a SpanBar); it never indents with the text.
    pub fn bar(mut self, bar: impl IntoElement) -> Self {
        self.bar = Some(bar.into_any_element());
        self
    }

    pub fn open(mut self, open: bool) -> Self {
        self.open = open;
        self
    }

    /// Indents only the text (title line, description, panel) by 16px per `level`; the fill and
    /// the bar keep the full width. `cue` joins the description (a depth mark).
    pub fn indent(mut self, level: u32, cue: Option<SharedString>) -> Self {
        self.indent = Some((level, cue));
        self
    }

    pub fn on_toggle(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_toggle = Some(Rc::new(handler));
        self
    }
}

impl ParentElement for DisclosureRow {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// Rows in a list: `.root + .root { margin-top: var(--space-xs) }`.
pub fn list(rows: impl IntoIterator<Item = DisclosureRow>) -> Stack {
    Stack::new().gap(Space::Xs).children(rows)
}

impl RenderOnce for DisclosureRow {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let interactive = self.reveals || !self.children.is_empty() || self.count.unwrap_or(0) > 0;
        let plain = self.surface == Surface::Plain;
        let ds = Ds::get(cx);
        let layout = Layout::new(&self, interactive, ds);
        let turn = parts::chevron_turn(&self.id, self.open && interactive, window, cx);
        let ds = Ds::get(cx);
        let radius = ds.len(Length::RadiusControl);
        let panel = (!self.children.is_empty()).then(|| {
            let padded = div()
                .pl(layout.panel_inset())
                .pr(layout.inset)
                .pb(if plain { px(0.) } else { layout.inset })
                .pt(if plain {
                    ds.len(Length::SpaceXs)
                } else {
                    px(0.)
                })
                .text_color(ds.color(Color::TextSecondary))
                .children(std::mem::take(&mut self.children));
            Collapsible::new((self.id.clone(), "panel"), self.open).child(padded)
        });
        let content = line(&mut self, &layout, turn, ds);
        let trigger = trigger(self.id.clone(), content, &layout, &self);
        let mut root = div().rounded(radius).child(trigger);
        if self.open && interactive && !plain {
            root = root.bg(ds.color(Color::Selection));
        }
        root.children(panel)
    }
}

/// The trigger: a stretched Clickable, or a static box with the same padding and height.
fn trigger(id: ElementId, content: Div, layout: &Layout, row: &DisclosureRow) -> AnyElement {
    let padded = content.py(layout.block);
    if !layout.interactive {
        return div()
            .min_h(layout.min_height)
            .flex()
            .flex_col()
            .justify_center()
            .w_full()
            .px(layout.pad)
            .child(padded.pl(layout.indent))
            .into_any_element();
    }
    let padded = padded.pl(layout.indent);
    let mut clickable = Clickable::new(id)
        .stretch()
        .metrics(layout.pad, layout.min_height);
    if row.surface == Surface::Plain {
        clickable = clickable.bleed(Bleed::Inline);
    }
    if let Some(toggle) = row.on_toggle.clone() {
        clickable = clickable.on_click(move |event, window, cx| toggle(event, window, cx));
    }
    clickable.child(padded.w_full()).into_any_element()
}
