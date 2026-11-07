//! DS ElementChip (ElementChip.tsx / ElementChip.module.css): a picked page element as an
//! attachment: its crop whole on a neutral matte, a title over the site, and in the composer a
//! remove button. A missing or broken crop shows the pick glyph.
use std::rc::Rc;

use gpui::{
    App, ClickEvent, ElementId, ImageSource, IntoElement, ObjectFit, ParentElement, RenderOnce,
    SharedString, Styled as _, StyledImage as _, Window, div, img, px,
};

use super::scope::{self, ActionScale};
use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::icon::{IconSize, icon, icon_px};
use crate::ui::icon_button::IconButton;
use crate::ui::tooltip::Tooltip;

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct ElementChip {
    id: ElementId,
    src: Option<ImageSource>,
    title: SharedString,
    site: SharedString,
    remove: Option<(SharedString, Handler)>,
}

impl ElementChip {
    pub fn new(
        id: impl Into<ElementId>,
        title: impl Into<SharedString>,
        site: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            src: None,
            title: title.into(),
            site: site.into(),
            remove: None,
        }
    }

    /// The picked element's crop.
    pub fn src(mut self, src: impl Into<ImageSource>) -> Self {
        self.src = Some(src.into());
        self
    }

    /// Composer: removes the chip; `label` is "Remove" (the title is appended).
    pub fn on_remove(
        mut self,
        label: impl Into<SharedString>,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.remove = Some((label.into(), Rc::new(handler)));
        self
    }
}

/// The crop whole on a neutral matte (contain), or the pick glyph without one.
fn crop(src: Option<ImageSource>, ds: &Ds) -> gpui::Div {
    let strong = ds.len(Length::BorderWidthStrong);
    let matte = div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .overflow_hidden()
        .size(ds.len(Length::ControlHeightSm))
        .p(strong)
        .rounded(ds.len(Length::RadiusControl) - strong)
        .bg(ds.color(Color::Muted))
        .text_color(ds.color(Color::TextTertiary));
    match src {
        Some(src) => matte.child(
            img(src)
                .max_w_full()
                .max_h_full()
                .object_fit(ObjectFit::Contain)
                .with_fallback({
                    let side = ds.len(Length::IconSizeSm);
                    move || icon_px(Icon::Pick, side).into_any_element()
                }),
        ),
        None => matte.child(icon(Icon::Pick, IconSize::Sm, ds)),
    }
}

impl RenderOnce for ElementChip {
    fn render(mut self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let strong = ds.len(Length::BorderWidthStrong);
        let radius = ds.len(Length::RadiusControl);
        let crop = crop(self.src.take(), ds);
        let tip = format!("{} · {}", self.title, self.site);
        let line = ds.len(Length::TypoCaptionLineHeightTight);
        let line_text = |text: SharedString, color: Color| {
            div()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .text_size(ds.len(Length::FontSize1))
                .line_height(line)
                .text_color(ds.color(color))
                .child(text)
        };
        let text = Tooltip::new((self.id.clone(), "tip")).label(tip).child(
            div()
                .flex()
                .flex_col()
                .flex_auto()
                .min_w_0()
                .child(line_text(self.title.clone(), Color::TextPrimary))
                .child(line_text(self.site, Color::TextTertiary)),
        );
        let removable = self.remove.is_some();
        let height = ds.len(Length::ControlHeightMd) + ds.len(Length::SpaceSm) - strong;
        let mut chip = div()
            .flex()
            .flex_initial()
            .items_center()
            .min_w_0()
            .max_w(px(220.))
            .h(height)
            .gap(ds.len(Length::SpaceSm))
            .pl(px(3.))
            .py(px(3.))
            .pr(if removable {
                px(0.)
            } else {
                ds.len(Length::SpaceSm)
            })
            .border(ds.len(Length::BorderHairline))
            .border_color(ds.color(Color::Line))
            .rounded(radius)
            .bg(ds.color(Color::ComposerGlassControlBg))
            .child(crop)
            .child(text);
        if let Some((label, handler)) = self.remove {
            let small = ScaleSpec::button(f32::from(ds.len(Length::ControlHeightXs)), 16.);
            let button = IconButton::new((self.id, "remove"), format!("{label}: {}", self.title))
                .icon(icon(Icon::X, IconSize::Sm, ds))
                .on_click(move |event, window, cx| handler(event, window, cx));
            chip = chip.child(
                div()
                    .flex_none()
                    .mr(ds.len(Length::SpaceXs))
                    .child(scope::scoped(
                        scope::Spec {
                            action: Some(small),
                            ..scope::Spec::default()
                        },
                        button,
                    )),
            );
        }
        chip
    }
}

/// `--icon-button-size` for a chip's remove button.
struct ScaleSpec;

impl ScaleSpec {
    fn button(side: f32, glyph: f32) -> ActionScale {
        ActionScale {
            side,
            icon: glyph,
            fixed: true,
        }
    }
}
