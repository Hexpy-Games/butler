//! SetupWizardContent and SetupWizardList (SetupWizardContent.tsx, `.content` / `.list` of
//! SetupWizardShell.module.css): the content column of a step. In the wizard it is 52ch (the
//! `Wide` width fills the body); in the focus variant 420px (`Wide`: 520px). `solid` puts it on
//! an opaque card over the wallpaper with one shared token inset.
use gpui::{
    AnyElement, App, IntoElement, ParentElement, RenderOnce, Styled as _, Window, canvas, div, px,
};

use super::{SetupWizardVariant, record_card};
use crate::tokens::Length;
use crate::ui::blocks::measure;
use crate::ui::context::Ds;
use crate::ui::layout::{Border, Box as LayoutBox, Elevation, Radius, Space, Stack, Surface};

/// The focus column widths. // DS: SetupWizardShell.module.css:247-253
const FOCUS_WIDTH: f32 = 420.;
const FOCUS_WIDE: f32 = 520.;
/// The wizard column's measure, in `ch`. // DS: SetupWizardShell.module.css:100
const WIZARD_CH: f32 = 52.;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ContentWidth {
    #[default]
    Default,
    Wide,
}

#[derive(IntoElement)]
pub struct SetupWizardContent {
    width: ContentWidth,
    solid: bool,
    variant: SetupWizardVariant,
    children: Vec<AnyElement>,
}

impl SetupWizardContent {
    pub fn new() -> Self {
        Self {
            width: ContentWidth::Default,
            solid: false,
            variant: SetupWizardVariant::Wizard,
            children: Vec::new(),
        }
    }

    pub fn width(mut self, width: ContentWidth) -> Self {
        self.width = width;
        self
    }

    /// `surface="solid"`: the opaque raised card (hairline, card shadow, panel radius, lg inset).
    pub fn solid(mut self) -> Self {
        self.solid = true;
        self
    }

    /// The shell variant the column sits in (CSS reads it from the screen's `data-variant`).
    pub fn variant(mut self, variant: SetupWizardVariant) -> Self {
        self.variant = variant;
        self
    }
}

impl Default for SetupWizardContent {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for SetupWizardContent {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for SetupWizardContent {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let max = match (self.variant, self.width) {
            (SetupWizardVariant::Focus, ContentWidth::Default) => Some(FOCUS_WIDTH),
            (SetupWizardVariant::Focus, ContentWidth::Wide) => Some(FOCUS_WIDE),
            (SetupWizardVariant::Wizard, ContentWidth::Default) => {
                let zero = measure::text_width("0", Length::TypoBodySize, window, cx);
                Some(zero * WIZARD_CH)
            }
            (SetupWizardVariant::Wizard, ContentWidth::Wide) => None,
        };
        let column = Stack::new().gap(Space::Lg).children(self.children);
        let body: AnyElement = if self.solid {
            LayoutBox::new()
                .surface(Surface::RaisedOpaque)
                .elevation(Elevation::Card)
                .border(Border::Hairline)
                .radius(Radius::Panel)
                .padding(Space::Lg)
                .child(column)
                .into_any_element()
        } else {
            column.into_any_element()
        };
        let frame = div().relative().w_full().min_w_0();
        let frame = match max {
            Some(max) => frame.max_w(px(max)),
            None => frame,
        };
        frame.child(body).children(self.solid.then(card_probe))
    }
}

/// `data-setup-card`: records the solid card's window rect for the shell's riso keep-out and
/// asks for another frame when it moved, so the backdrop takes it.
fn card_probe() -> AnyElement {
    canvas(
        |_, _, _| (),
        |bounds, (), window, cx: &mut App| {
            if record_card(bounds, cx) {
                crate::ui::motion::remeasure(window);
            }
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
    .into_any_element()
}

/// The rows of a step's list, indented one `xl` step. // DS: SetupWizardShell.module.css:107
#[derive(IntoElement)]
pub struct SetupWizardList {
    children: Vec<AnyElement>,
}

impl SetupWizardList {
    pub fn new() -> Self {
        Self {
            children: Vec::new(),
        }
    }
}

impl Default for SetupWizardList {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for SetupWizardList {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for SetupWizardList {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        div()
            .pl(Space::Xl.px(Ds::get(cx)))
            .child(Stack::new().gap(Space::Sm).children(self.children))
    }
}
