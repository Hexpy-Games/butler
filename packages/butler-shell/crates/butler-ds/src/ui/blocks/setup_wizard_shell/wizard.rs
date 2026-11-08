//! The wizard variant (`.shell`, `.header`, `.productTitle`, `.body`, `.scrollArea`,
//! `.scrollContent` of SetupWizardShell.module.css): the product title and stepper over a glass
//! body that scrolls its content.
use gpui::{
    AnyElement, App, Div, ElementId, FontWeight, IntoElement as _, ParentElement as _,
    SharedString, Styled as _, div, px,
};

use super::progress::{SetupWizardProgress, SetupWizardStep};
use crate::tokens::{Color, Length, Number};
use crate::ui::context::{Ds, keep_words};
use crate::ui::scroll::ScrollArea;
use crate::ui::tinted_glass::{GlassPadding, GlassRadius, TintedGlass};
use crate::ui::typo::Typo;

/// The body's height clamp and the room the title row and gaps take from the window.
/// // DS: SetupWizardShell.module.css:67-79
const BODY_MIN: f32 = 360.;
const BODY_SHARE: f32 = 0.54;
const BODY_MAX: f32 = 560.;
const BODY_CHROME: f32 = 104.;
/// At 560px and below. // DS: SetupWizardShell.module.css:259-271
const NARROW_BODY_MAX: f32 = 520.;
const NARROW_CHROME: f32 = 96.;
/// The title steps down at these widths. // DS: SetupWizardShell.module.css:274-276
const TITLE_MEDIUM_MAX: f32 = 920.;

pub(super) struct Wizard {
    pub id: ElementId,
    pub title: SharedString,
    pub steps: Vec<SetupWizardStep>,
    pub active_index: usize,
    pub narrow: bool,
    pub children: Vec<AnyElement>,
}

/// The glass body's height: a share of the window between the clamps, never past the room left.
fn body_height(wizard: &Wizard, ds: &Ds) -> f32 {
    let viewport = f32::from(ds.len(Length::AdaptiveViewportBlockSize));
    let (lg, xxl) = (
        f32::from(ds.len(Length::SpaceLg)),
        f32::from(ds.len(Length::Space2xl)),
    );
    let height = if wizard.narrow {
        NARROW_BODY_MAX.min(viewport - lg * 2. - NARROW_CHROME)
    } else {
        (BODY_SHARE * viewport)
            .clamp(BODY_MIN, BODY_MAX)
            .min(viewport - xxl * 2. - BODY_CHROME)
    };
    height.max(0.)
}

/// The product title in the new-chat title tokens, words kept together.
fn title(wizard: &Wizard, ds: &Ds, cx: &App) -> Div {
    let width = ds.tokens().viewport.0;
    let (size, line) = if wizard.narrow {
        (
            Length::TypoNewChatTitleSizeSm,
            Length::TypoNewChatTitleLineHeightSm,
        )
    } else if width <= TITLE_MEDIUM_MAX {
        (
            Length::TypoNewChatTitleSizeMd,
            Length::TypoNewChatTitleLineHeightMd,
        )
    } else {
        (
            Length::TypoNewChatTitleSize,
            Length::TypoNewChatTitleLineHeight,
        )
    };
    let weight = ds.number(Number::TypoNewChatTitleWeight);
    let family = ds.body_font().clone();
    let (px_size, px_line) = (f32::from(ds.len(size)), ds.len(line));
    let (ascent, descent) = Typo::extent(&family, px_size, weight, cx);
    let excess = (ascent + descent - f32::from(px_line)).max(0.);
    let offset = Typo::trim_offset(&family, px_size, cx, weight) - excess / 2.;
    let mut el = div()
        .mb(px(-excess))
        .text_size(px(px_size))
        .line_height(px_line)
        .font_weight(FontWeight(weight))
        .font_family(family)
        .text_color(ds.color(Color::TextPrimary));
    el.text_style().letter_spacing = Some(px(ds.number(Number::TypoNewChatTitleLetterSpacing)));
    keep_words(el.child(div().relative().top(px(offset)).child(wizard.title.clone())))
}

pub(super) fn body(wizard: Wizard, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let inset = ds.len(Length::SpaceLg);
    let heading = title(&wizard, ds, cx);
    let height = body_height(&wizard, ds);
    let Wizard {
        id,
        steps,
        active_index,
        children,
        ..
    } = wizard;
    let mut header = div()
        .flex()
        .flex_col()
        .gap(ds.len(Length::SpaceSm))
        // The title and stepper start where the body content starts: its inset plus its border.
        .px(inset + ds.len(Length::BorderHairline))
        .child(heading);
    if !steps.is_empty() {
        header = header.child(SetupWizardProgress::new(steps, active_index));
    }
    let content = div().w_full().min_h_full().p(inset).children(children);
    let glass = TintedGlass::new()
        .radius(GlassRadius::Panel)
        .padding(GlassPadding::None)
        .height(px(height))
        .child(ScrollArea::new((id, "scroll")).fill().child(content));
    div()
        .relative()
        .w_full()
        .max_w(ds.len(Length::PageContainerNarrow))
        .flex()
        .flex_col()
        .gap(inset)
        .child(header)
        .child(glass)
        .into_any_element()
}
