//! DS ComposerCard (ComposerCard.tsx / ComposerCard.module.css): the glass card the composer
//! lives in. Rows: a notice slot, then the card (an adjunct slot, the editor region, the toolbar);
//! an optional decoration fills the card behind the content, and an edge character peeks over its
//! top edge. The card is the same DS TintedGlass surface every overlay uses, at the composer
//! radius. The editor is a slot: the rich-text editing is the app's, a DS Textarea fills it in a
//! showcase. A `composer` container query (width <= 520px) tightens the control row, which the
//! card passes down in [`scope::ComposerVars`].
mod edge;
mod parts;

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement, RenderOnce, Styled as _, Window, div,
    px,
};

pub use edge::{EdgeCharacter, EdgeKind, EdgePart, RISE as EDGE_CHARACTER_RISE};
pub use parts::{
    CompactPreview, ExpandedBody, ExpandedControls, PlanToggle, SendButton, SendMode, Toolbar,
    ToolbarSpacer, editor, placeholder, textarea,
};

use crate::tokens::{Color, Length};
use crate::ui::blocks::scope::{self, ComposerVars, Spec};
use crate::ui::blocks::{measure, scope::scoped};
use crate::ui::context::Ds;
use crate::ui::tinted_glass::{GlassPadding, GlassRadius, TintedGlass};

/// `ComposerCardEdge`: art on the card's top edge. `behind` paints under the card (it hides the
/// part below the edge), `front` over its top edge; `reserve_top` is the px the edge content
/// rises above the card, which the card reserves above itself.
#[derive(Default)]
pub struct Edge {
    behind: Option<AnyElement>,
    front: Option<AnyElement>,
    reserve_top: f32,
}

impl Edge {
    /// A character's two parts, reserving the room it rises into.
    pub fn character(kind: EdgeKind) -> Self {
        Self {
            behind: Some(EdgeCharacter::new(kind, EdgePart::Behind).into_any_element()),
            front: Some(EdgeCharacter::new(kind, EdgePart::Front).into_any_element()),
            reserve_top: EDGE_CHARACTER_RISE,
        }
    }
}

/// The inner padding of the card (`--composer-inner-padding-inline`, `-block`).
const INNER_PADDING: (Length, Length) = (Length::Space4, Length::Space3);
/// `@container composer (width <= 520px)`.
const NARROW: f32 = 520.;
/// `max-width: 920px` of the wrap, and the column width it follows without a conversation.
const MAX_WIDTH: f32 = 920.;
const COLUMN_WIDTH: f32 = 760.;

#[derive(IntoElement)]
pub struct ComposerCard {
    id: ElementId,
    large: bool,
    drop_active: bool,
    expanded: bool,
    adjunct: Option<AnyElement>,
    notice: Option<AnyElement>,
    decoration: Option<AnyElement>,
    edge: Edge,
    children: Vec<AnyElement>,
}

impl ComposerCard {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            large: false,
            drop_active: false,
            expanded: true,
            adjunct: None,
            notice: None,
            decoration: None,
            edge: Edge::default(),
            children: Vec::new(),
        }
    }

    /// The new-chat composer (the same column width; a position the shell chooses).
    pub fn large(mut self) -> Self {
        self.large = true;
        self
    }

    /// A drag over the card: the interactive border and ring.
    pub fn drop_active(mut self) -> Self {
        self.drop_active = true;
        self
    }

    /// `expanded`: false folds the editor and shows the one-line preview.
    pub fn expanded(mut self, expanded: bool) -> Self {
        self.expanded = expanded;
        self
    }

    /// The panel attached above the editor (steps, workers).
    pub fn adjunct(mut self, adjunct: impl IntoElement) -> Self {
        self.adjunct = Some(adjunct.into_any_element());
        self
    }

    /// A notice above the card.
    pub fn notice(mut self, notice: impl IntoElement) -> Self {
        self.notice = Some(notice.into_any_element());
        self
    }

    /// Art behind the content, filling the card and clipped by its radius. No scrim.
    pub fn decoration(mut self, decoration: impl IntoElement) -> Self {
        self.decoration = Some(decoration.into_any_element());
        self
    }

    pub fn edge(mut self, edge: Edge) -> Self {
        self.edge = edge;
        self
    }
}

impl ParentElement for ComposerCard {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl ComposerCard {
    /// The glass surface, with the decoration (if any) clipped to the card's radius.
    fn glass(&mut self, radius: gpui::Pixels) -> TintedGlass {
        let mut glass = TintedGlass::new()
            .radius(GlassRadius::Composer)
            .padding(GlassPadding::None);
        if let Some(decoration) = self.decoration.take() {
            glass = glass.child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .overflow_hidden()
                    .rounded(radius)
                    .child(decoration),
            );
        }
        glass
    }

    /// The card's column: the adjunct (when expanded) above the children.
    fn content(&mut self, ds: &Ds) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .min_w_0()
            .children(
                self.adjunct
                    .take()
                    .filter(|_| self.expanded)
                    .map(|adjunct| {
                        div()
                            .min_w_0()
                            .border_b(ds.len(Length::BorderHairline))
                            .border_color(ds.color(Color::ComposerGlassDivider))
                            .child(adjunct)
                    }),
            )
            .children(std::mem::take(&mut self.children))
    }
}

impl RenderOnce for ComposerCard {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (size, recorder) = measure::track((self.id.clone(), "wrap"), window, cx);
        let column = scope::conversation(cx)
            .map(|vars| vars.column_width)
            .filter(|width| *width > 0.)
            .unwrap_or(COLUMN_WIDTH);
        let ds = Ds::get(cx);
        let vars = ComposerVars {
            narrow: f32::from(size.width) <= NARROW && size.width > px(0.),
            padding: (
                f32::from(ds.len(INNER_PADDING.0)),
                f32::from(ds.len(INNER_PADDING.1)),
            ),
            expanded: self.expanded,
        };
        let radius = ds.len(Length::AdaptiveComposerRadius);
        let notice = self
            .notice
            .take()
            .map(|notice| div().mb(ds.len(Length::SpaceSm)).child(notice));
        let glass = self.glass(radius);
        let content = self.content(ds);
        let card = div()
            .relative()
            .w_full()
            .rounded(radius)
            .child(glass.child(scoped(
                Spec {
                    composer: Some(vars),
                    ..Spec::default()
                },
                content,
            )))
            .children(self.drop_active.then(|| drop_ring(ds, radius)));
        // The edge layers share the card's row: a zero-height strip on the form's top edge.
        let strip = |content: Option<AnyElement>| {
            content.map(|content| {
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .w_full()
                    .h_0()
                    .child(content)
            })
        };
        let (behind, front) = (self.edge.behind.take(), self.edge.front.take());
        div()
            .relative()
            .w_full()
            .max_w(px(column.min(MAX_WIDTH)))
            .mx_auto()
            .pt(px(self.edge.reserve_top))
            .child(recorder)
            .children(notice)
            .child(
                div()
                    .relative()
                    .children(strip(behind))
                    .child(card)
                    .children(strip(front)),
            )
    }
}

/// `[data-drop-active]`: the interactive border and a 3px ring around the card, painted outside
/// it (a spread shadow of a clear box would fill it).
fn drop_ring(ds: &Ds, radius: gpui::Pixels) -> AnyElement {
    let ring = gpui::BoxShadow {
        color: ds.color(Color::Ring).into(),
        offset: gpui::point(px(0.), px(0.)),
        blur_radius: px(0.),
        spread_radius: px(3.),
        inset: false,
    };
    div()
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .rounded(radius)
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::ColorBorderInteractive))
        .child(crate::ui::control::ring_layer(vec![ring], radius))
        .into_any_element()
}
