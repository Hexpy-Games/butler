//! SetupWizardContent and SetupWizardList (SetupWizardContent.tsx, `.content` / `.list` of
//! SetupWizardShell.module.css): the content column of a step. In the wizard it is 52ch (the
//! `Wide` width fills the body); in the focus variant 420px (`Wide`: 520px). `solid` puts it on
//! an opaque card over the wallpaper with one shared token inset.
use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement, ParentElement, RenderOnce, Styled as _,
    Window, canvas, div, px,
};

use super::{SetupWizardMorph, SetupWizardVariant, record_card, rise_row, settle_rows};
use crate::tokens::{Color, Duration as DsDuration, Easing, Length, Shadow};
use crate::ui::blocks::measure;
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::layout::{Box as LayoutBox, Radius, Space, Stack};
use crate::ui::motion::Timing;

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
    rows: Option<SetupWizardMorph>,
    children: Vec<AnyElement>,
}

impl SetupWizardContent {
    pub fn new() -> Self {
        Self {
            width: ContentWidth::Default,
            solid: false,
            variant: SetupWizardVariant::Wizard,
            rows: None,
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

    /// Each child is a row that arrives in order after a card morph. A `SetupWizardStepCard`
    /// child owns its rows.
    pub fn rows(mut self, morph: &SetupWizardMorph) -> Self {
        self.rows = Some(morph.clone());
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
        let mut column = Stack::new().gap(Space::Lg);
        if let Some(since) = self.rows.as_ref().and_then(SetupWizardMorph::since) {
            let ds = Ds::get(cx);
            let mut count = 0;
            column = column.children(self.children.into_iter().map(|row| {
                let row = rise_row(row, count, since, ds);
                count += 1;
                row
            }));
            settle_rows(count, since, window, cx);
        } else {
            column = column.children(self.children);
        }
        let frame = div().relative().w_full().min_w_0();
        let frame = match max {
            Some(max) => frame.max_w(px(max)),
            None => frame,
        };
        if !self.solid {
            return frame.child(column);
        }
        let ds = Ds::get(cx);
        let deliberate = Timing::token(
            ds,
            DsDuration::MotionDeliberate,
            Easing::MotionEaseEmphasized,
        );
        let hairline = ds.len(Length::BorderHairline);
        let surface = div()
            .id("setup-card-surface")
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .bg(ds.color(Color::ColorSurfaceRaisedOpaque))
            .border(hairline)
            .border_color(ds.color(Color::Line))
            .rounded(Radius::Panel.px(ds))
            .shadow(convert::box_shadows(
                ds.tokens().shadow(Shadow::ShadowCard),
                ds.tokens(),
            ))
            .layout_motion(gpui::LayoutMotion {
                duration_ms: if ds.reduced_motion() {
                    0
                } else {
                    deliberate.ms()
                },
                easing: deliberate.easing(),
            });
        let content = div().relative().min_w_0().p(hairline).child(
            LayoutBox::new()
                .radius(Radius::Panel)
                .padding(Space::Lg)
                .child(column),
        );
        frame.child(surface).child(content).child(card_probe())
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
