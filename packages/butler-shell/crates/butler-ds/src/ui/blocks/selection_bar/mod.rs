//! DS SelectionBar (SelectionBar.tsx / SelectionBar.module.css): the picked-elements toolbar
//! over the page. A count, the actions and Clear on one line at every width, in the overlay
//! layer so the live page is never covered by a still. From the moment pick mode starts it shows
//! at 0 with a pick glyph, a hint and unavailable actions (`empty_reason` as their tooltip,
//! Clear hidden). With less than 620px of room the actions drop their words and keep their icons
//! and tooltips; below 340px the count label (or hint) drops too. `compact` is the small pill
//! kept after picking ends (nothing at 0); `dimmed` while the picks are dragged out.
//!
//! The width queries read the host's own measured width, as the CSS container does. Not
//! reproduced: `role="toolbar"` and its accessible name (the shell has no accessibility tree).
//! An unavailable icon-only action is a native-disabled `IconButton` (the primitive has no
//! `aria-disabled` form): its `label · reason` tooltip shows on hover but it is not focusable.
mod actions;

use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement as _, RenderOnce, SharedString,
    Styled as _, Window, div,
};

pub use actions::SelectionBarAction;

use super::measure;
use crate::tokens::{Color, Duration as DsDuration, Easing, Length, Number, Shadow};
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::convert::box_shadows;
use crate::ui::icon::{IconSize, icon};
use crate::ui::icon_button::IconButton;
use crate::ui::motion::{self, Props, Timing};
use crate::ui::strut;
use crate::ui::typo::{Role, Tone, Typo, Weight, Wrap};

/// `@container selection-bar (width < 620px)`: icon-only actions.
const WIDE_MIN: f32 = 620.; // DS: SelectionBar.module.css:105
/// `@container selection-bar (width < 340px)`: the label drops.
const LABEL_MIN: f32 = 340.; // DS: SelectionBar.module.css:116
/// `opacity: 0.55` of the dragged-out bar.
const DIMMED_OPACITY: f32 = 0.55; // DS: SelectionBar.module.css:53

/// `floating` (default): bottom centre of the page area (PageCard `overlay`). `inline`: in flow.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SelectionPlacement {
    #[default]
    Floating,
    Inline,
}

type ClearHandler = Rc<dyn Fn(&mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct SelectionBar {
    id: ElementId,
    count: usize,
    label: SharedString,
    hint: Option<SharedString>,
    empty_reason: Option<SharedString>,
    actions: Vec<SelectionBarAction>,
    compact: bool,
    dimmed: bool,
    on_clear: Option<ClearHandler>,
    clear_label: SharedString,
    placement: SelectionPlacement,
}

impl SelectionBar {
    /// `label`: the count in words ("2 selected"). `clear_label` names the Clear button.
    pub fn new(
        id: impl Into<ElementId>,
        count: usize,
        label: impl Into<SharedString>,
        clear_label: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            count,
            label: label.into(),
            hint: None,
            empty_reason: None,
            actions: Vec::new(),
            compact: false,
            dimmed: false,
            on_clear: None,
            clear_label: clear_label.into(),
            placement: SelectionPlacement::Floating,
        }
    }

    /// At 0: what to do ("Click elements to pick them"), in place of the count label.
    pub fn hint(mut self, hint: impl Into<SharedString>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// At 0: why the actions are unavailable ("Pick an element first"), every action's tooltip.
    pub fn empty_reason(mut self, reason: impl Into<SharedString>) -> Self {
        self.empty_reason = Some(reason.into());
        self
    }

    /// An action, in order; the compact pill keeps only the first.
    pub fn action(mut self, action: SelectionBarAction) -> Self {
        self.actions.push(action);
        self
    }

    /// Picking is off but the selection stays on the tab: a small pill (nothing at 0).
    pub fn compact(mut self) -> Self {
        self.compact = true;
        self
    }

    /// The picks are being dragged out of the page.
    pub fn dimmed(mut self, dimmed: bool) -> Self {
        self.dimmed = dimmed;
        self
    }

    /// Clears the picks; hidden at 0.
    pub fn on_clear(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_clear = Some(Rc::new(handler));
        self
    }

    pub fn placement(mut self, placement: SelectionPlacement) -> Self {
        self.placement = placement;
        self
    }
}

/// How the bar lays out in the room its host gives it.
struct Fit {
    wide: bool,
    label: bool,
}

impl SelectionBar {
    fn name(&self) -> SharedString {
        if self.count == 0 {
            self.hint.clone().unwrap_or_else(|| self.label.clone())
        } else {
            self.label.clone()
        }
    }

    /// The `count` bubble: the number, or the pick glyph while nothing is picked.
    fn bubble(&self, ds: &Ds) -> impl IntoElement + use<> {
        let empty = self.count == 0;
        let side = ds.len(Length::SpaceXl) + ds.len(Length::BorderWidthStrong);
        let content: AnyElement = if empty {
            icon(Icon::Pick, IconSize::Sm, ds).into_any_element()
        } else {
            let text = if self.count > 99 {
                "99+".to_owned()
            } else {
                self.count.to_string()
            };
            Typo::new(Role::Text, text)
                .tabular()
                .tone(Tone::Inherit)
                .into_any_element()
        };
        let (fill, ink) = if empty {
            (Color::Muted, Color::TextSecondary)
        } else {
            (Color::Accent, Color::NeutralWhite)
        };
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .min_w(side)
            .h(side)
            .px(ds.len(Length::SpaceXs))
            .rounded(ds.len(Length::RadiusPill))
            .bg(ds.color(fill))
            .text_color(ds.color(ink))
            .text_size(ds.len(Length::FontSize1))
            .line_height(ds.len(Length::TypoCaptionLineHeight))
            .font_weight(gpui::FontWeight(ds.number(Number::FontWeightSemibold)))
            .child(content)
    }

    /// The count label, or at 0 the hint, which ellipsizes before anything wraps.
    fn caption(&self) -> impl IntoElement + use<> {
        let name = self.name();
        if self.count == 0 {
            div().min_w_0().overflow_hidden().child(
                Typo::new(Role::Text, name)
                    .tone(Tone::Secondary)
                    .weight(Weight::Regular)
                    .truncate(),
            )
        } else {
            div().flex_none().child(
                Typo::new(Role::Text, name)
                    .weight(Weight::Medium)
                    .wrap(Wrap::Nowrap),
            )
        }
    }
}

fn separator(ds: &Ds) -> impl IntoElement + use<> {
    div()
        .flex_none()
        .w(ds.len(Length::BorderHairline))
        .h(ds.len(Length::IconSizeSm))
        .bg(ds.color(Color::LineStrong))
}

impl SelectionBar {
    /// The bar's items in order, as the TSX lists them.
    fn items(&self, fit: &Fit, ds: &Ds) -> Vec<AnyElement> {
        let empty = self.count == 0;
        let mut items = vec![self.bubble(ds).into_any_element()];
        if fit.label {
            items.push(self.caption().into_any_element());
        }
        if !self.compact {
            items.push(separator(ds).into_any_element());
        }
        let shown = if self.compact { 1 } else { self.actions.len() };
        let reason = self
            .empty_reason
            .clone()
            .or_else(|| self.hint.clone())
            .unwrap_or_else(|| self.label.clone());
        let rows = self.actions.iter().take(shown).map(|action| {
            let why = action
                .disabled_reason()
                .cloned()
                .or_else(|| empty.then(|| reason.clone()));
            if fit.wide {
                action.wide(&self.id, why, ds)
            } else {
                action.narrow(&self.id, why, ds)
            }
        });
        items.push(
            actions::row(fit.wide)
                .children(rows.collect::<Vec<_>>())
                .into_any_element(),
        );
        if !self.compact && !empty {
            items.push(separator(ds).into_any_element());
        }
        if !empty {
            let on_clear = self.on_clear.clone();
            let mut clear = IconButton::new((self.id.clone(), "clear"), self.clear_label.clone())
                .icon(icon(Icon::X, IconSize::Sm, ds));
            if let Some(on_clear) = on_clear {
                clear = clear.on_click(move |_, window, cx| on_clear(window, cx));
            }
            items.push(clear.into_any_element());
        }
        items
    }
}

impl RenderOnce for SelectionBar {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        if self.count == 0 && self.compact {
            return gpui::Empty.into_any_element();
        }
        let (seen, recorder) = measure::track((self.id.clone(), "host"), window, cx);
        let ds = Ds::get(cx);
        // The container query reads the host's width; unmeasured, nothing drops yet.
        let width = f32::from(seen.width);
        let measured = seen.width > gpui::px(0.);
        let fit = Fit {
            wide: !measured || width >= WIDE_MIN,
            label: !measured || width >= LABEL_MIN,
        };
        let timing = Timing::token(ds, DsDuration::MotionFast, Easing::MotionEaseStandard);
        let dim = motion::transition(
            (self.id.clone(), "dim"),
            (if self.dimmed { 1. } else { 0. }, false),
            &timing,
            window,
            cx,
        );
        let ds = Ds::get(cx);
        let items = self.items(&fit, ds);
        let bar = div()
            .flex()
            .flex_none()
            .items_center()
            .gap(ds.len(Length::SpaceSm))
            .max_w_full()
            .h(ds.len(if self.compact {
                Length::ControlHeightLg
            } else {
                Length::BrowserBandHeight
            }))
            .pl(ds.len(Length::SpaceSm))
            .pr(ds.len(Length::SpaceXs))
            .border(ds.len(Length::BorderHairline))
            .border_color(ds.color(Color::Line))
            .rounded(ds.len(Length::RadiusPill))
            .bg(ds.color(Color::Popover))
            .shadow(box_shadows(
                ds.tokens().shadow(Shadow::ShadowWindow),
                ds.tokens(),
            ))
            .text_color(ds.color(Color::TextPrimary))
            .text_size(ds.len(Length::FontSize2))
            .line_height(ds.len(Length::TypoLabelLineHeight))
            .children(items);
        let props = Props {
            opacity: Some((1., DIMMED_OPACITY)),
            ..Props::default()
        };
        let bar = dim.apply(bar, &timing, &props);
        let host = div().relative().flex().items_center().child(recorder);
        let host = match self.placement {
            SelectionPlacement::Floating => {
                let room = ds.len(Length::SpaceLg);
                host.absolute()
                    .right(room)
                    .bottom(room)
                    .left(room)
                    .justify_center()
            }
            SelectionPlacement::Inline => host.w_full().justify_start(),
        };
        strut::scope(false, host.child(bar)).into_any_element()
    }
}
