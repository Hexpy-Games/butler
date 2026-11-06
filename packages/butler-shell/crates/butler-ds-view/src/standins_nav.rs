//! Stand-in for the NavRow block (NavRow.tsx / NavRow.module.css): a stretched Clickable with an
//! icon, a label that ellipsises, an optional badge and an optional action, sized by the sidebar
//! density. It lets the ProgressRing showcase draw its sidebar rows and goes away when the block
//! lands. It is not part of `butler-ds`; the badge's `4ch` to `7ch` width limits are left out (it
//! is right-aligned, so the row does not move).
use butler_ds::tokens::{Color, Density, Length, Number, TokenContext};
use butler_ds::ui::Icon;
use butler_ds::ui::clickable::Clickable;
use butler_ds::ui::context::Ds;
use gpui::{
    AnyElement, App, ElementId, FontWeight, IntoElement as _, ParentElement as _, SharedString,
    Styled as _, div, px, svg,
};

/// The row's box, from the density's tokens (`[data-sidebar-density]`, tokens.css:1008-1049).
struct Metrics {
    height: f32,
    padding: f32,
    gap: f32,
    icon: f32,
}

/// Without a density attribute the row reads the `:root` values: 30px rows, a 10px gap and the
/// 16px icon (tokens.css:785-788), and in a compact window the `@media (width <= 640px)` ones.
fn metrics(ds: &Ds, density: Option<Density>) -> Metrics {
    if let Some(density) = density {
        let tokens = TokenContext {
            density,
            ..*ds.tokens()
        };
        return Metrics {
            height: tokens.len(Length::SidebarRowHeight),
            padding: tokens.len(Length::SidebarRowPaddingInline),
            gap: tokens.len(Length::SidebarRowGap),
            icon: tokens.len(Length::SidebarIconSize),
        };
    }
    let padding = f32::from(ds.len(Length::SpaceSm));
    if ds.compact() {
        Metrics {
            height: 48., // DS: tokens.css:1116
            padding,
            gap: f32::from(ds.len(Length::SpaceMd)),
            icon: 22., // DS: tokens.css:1118
        }
    } else {
        Metrics {
            height: 30., // DS: tokens.css:785
            padding,
            gap: 10., // DS: tokens.css:788
            icon: f32::from(ds.len(Length::IconSizeMd)),
        }
    }
}

pub(crate) struct NavRow {
    id: ElementId,
    label: SharedString,
    icon: Option<AnyElement>,
    badge: Option<SharedString>,
    actions: Option<AnyElement>,
    density: Option<Density>,
}

impl NavRow {
    pub(crate) fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            icon: None,
            badge: None,
            actions: None,
            density: None,
        }
    }

    pub(crate) fn icon(mut self, icon: impl gpui::IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    /// A line icon drawn at the density's icon size (`.icon svg` takes `--sidebar-icon-size`).
    pub(crate) fn glyph(mut self, glyph: Icon, cx: &App) -> Self {
        let ds = Ds::get(cx);
        let side = metrics(ds, self.density).icon;
        self.icon = Some(
            svg()
                .path(glyph.path())
                .size(px(side))
                .text_color(ds.color(Color::TextPrimary))
                .into_any_element(),
        );
        self
    }

    pub(crate) fn badge(mut self, badge: impl Into<SharedString>) -> Self {
        self.badge = Some(badge.into());
        self
    }

    pub(crate) fn actions(mut self, actions: impl gpui::IntoElement) -> Self {
        self.actions = Some(actions.into_any_element());
        self
    }

    pub(crate) fn density(mut self, density: Density) -> Self {
        self.density = Some(density);
        self
    }

    pub(crate) fn build(self, cx: &App) -> AnyElement {
        let ds = Ds::get(cx);
        let m = metrics(ds, self.density);
        let compact = ds.compact();
        let (size, line) = if compact {
            (Length::FontSize4, Length::TypoAppTitleLineHeight)
        } else {
            (Length::FontSize2, Length::TypoLabelLineHeight)
        };
        let label = div()
            .flex_1()
            .min_w_0()
            .overflow_hidden()
            .whitespace_nowrap()
            .text_ellipsis()
            .font_family(ds.body_font().clone())
            .font_weight(FontWeight(ds.number(Number::FontWeightRegular)))
            .text_size(ds.len(size))
            .line_height(ds.len(line))
            .child(self.label);
        let icon = self.icon.map(|icon| {
            div()
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(px(m.icon))
                .opacity(0.82) // DS: NavRow.module.css:164
                .child(icon)
        });
        let labels = div()
            .flex()
            .flex_1()
            .min_w_0()
            .items_center()
            .gap(px(m.gap))
            .children(icon)
            .child(label);
        let badge = self.badge.map(|badge| {
            div()
                .flex_none()
                .overflow_hidden()
                .text_right()
                .text_color(ds.color(Color::TextTertiary))
                .font_family(ds.body_font().clone())
                .text_size(ds.len(Length::FontSize1))
                .line_height(ds.len(Length::TypoCaptionLineHeight))
                .child(badge)
        });
        let controls = (badge.is_some() || self.actions.is_some()).then(|| {
            div()
                .flex()
                .flex_none()
                .items_center()
                .justify_end()
                .gap(ds.len(Length::Space1))
                .children(badge)
                .children(self.actions)
        });
        Clickable::new(self.id)
            .stretch()
            .metrics(px(m.padding), px(m.height))
            .on_click(|_, _, _| {})
            .child(
                div()
                    .flex()
                    .w_full()
                    .items_center()
                    .gap(px(m.gap))
                    .child(labels)
                    .children(controls),
            )
            .into_any_element()
    }
}
