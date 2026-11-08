//! DS InlineReference (InlineReference.tsx, ExternalReference.tsx, FaviconSlot.tsx,
//! externalHref.ts): a mention of a conversation or document, or an external http(s) link, in
//! running text. gpui has no inline flow of elements inside text, so a sentence is an
//! [`InlineFlow`]: a wrapping, baseline-aligned run whose text is cut into words and whose
//! references are cut the way the CSS breaks them (the icon and the first character of an
//! external label never part; the rest of the label wraps anywhere).
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, ImageSource, InteractiveElement as _, IntoElement,
    ParentElement as _, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _,
    StyledImage as _, Window, div, px,
};

use super::Icon;
use super::context::Ds;
use super::control::{Blend, Control, Ring};
use super::icon::icon_px;
use super::media_frame::{Load, resolve};
use super::motion::{Props, Timing};
use super::tooltip::Tooltip;
use crate::tokens::{Color, Duration as DsDuration, Easing, Length};

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

enum Kind {
    Mention {
        icon: Icon,
        unavailable: bool,
        on_click: Option<Handler>,
    },
    External {
        href: SharedString,
        favicon: Option<ImageSource>,
    },
}

#[derive(IntoElement)]
pub struct InlineReference {
    id: ElementId,
    label: Option<SharedString>,
    kind: Kind,
}

impl InlineReference {
    /// A conversation or document mention.
    pub fn mention(id: impl Into<ElementId>, icon: Icon, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: Some(label.into()),
            kind: Kind::Mention {
                icon,
                unavailable: false,
                on_click: None,
            },
        }
    }

    /// An external http(s) link; without a label (or with the URL itself) it shows the domain.
    pub fn external(id: impl Into<ElementId>, href: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: None,
            kind: Kind::External {
                href: href.into(),
                favicon: None,
            },
        }
    }

    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// An external link's favicon; the globe shows until it loads (and when it never does).
    pub fn favicon(mut self, source: impl Into<ImageSource>) -> Self {
        if let Kind::External { favicon, .. } = &mut self.kind {
            *favicon = Some(source.into());
        }
        self
    }

    /// A mention whose target is gone: dimmed.
    pub fn unavailable(mut self) -> Self {
        if let Kind::Mention { unavailable, .. } = &mut self.kind {
            *unavailable = true;
        }
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        if let Kind::Mention { on_click, .. } = &mut self.kind {
            *on_click = Some(Rc::new(handler));
        }
        self
    }
}

/// The host of a URL without `www.`, as written (`externalHrefLabel`).
fn host_label(href: &str) -> String {
    let rest = href.split_once("://").map_or(href, |(_, rest)| rest);
    let host = rest.split(['/', '?', '#', ':']).next().unwrap_or(rest);
    host.strip_prefix("www.").unwrap_or(host).to_owned()
}

/// True when the link text is the URL itself.
fn is_bare(text: &str, href: &str) -> bool {
    let strip = |url: &str| {
        let url = url.split_once("://").map_or(url, |(_, rest)| rest);
        url.trim_end_matches('/').to_lowercase()
    };
    let text = text.trim();
    text.is_empty() || strip(text) == strip(href)
}

/// Shared by the pieces of one reference: whether the pointer is over any of them.
fn hover_state(id: &ElementId, window: &mut Window, cx: &mut App) -> gpui::Entity<bool> {
    window.use_keyed_state((id.clone(), "hover"), cx, |_, _| false)
}

impl InlineReference {
    /// The reference as flow items: pieces that wrap with the sentence around them.
    pub(crate) fn items(self, window: &mut Window, cx: &mut App) -> Vec<AnyElement> {
        let style = window.text_style();
        let em = style.font_size.to_pixels(window.rem_size());
        match self.kind {
            Kind::Mention {
                icon,
                unavailable,
                on_click,
            } => {
                let ds = Ds::get(cx);
                let ink = ds.color(if unavailable {
                    Color::TextTertiary
                } else {
                    Color::AccentText
                });
                let mut control = Control::new(self.id, ds);
                control.fg = Blend::flat(ink);
                control.scale = false;
                control.ring = Ring::Outline(0.);
                control.radius = px(0.);
                control.gap = ds.len(Length::Space1);
                control.text_size = em;
                control.line_height = Some(style.line_height_in_pixels(window.rem_size()));
                control.weight = style.font_weight.0;
                control.not_allowed = false;
                control.on_click(on_click);
                control.children = vec![
                    div()
                        .flex_none()
                        .child(icon_px(icon, em))
                        .into_any_element(),
                    div()
                        .child(self.label.unwrap_or_default())
                        .into_any_element(),
                ];
                vec![control.into_any_element()]
            }
            Kind::External { href, favicon } => {
                external_items(&self.id, self.label, href, favicon.as_ref(), em, window, cx)
            }
        }
    }
}

/// The favicon slot: the globe at once, the favicon fading in over it once decoded.
fn favicon_slot(
    id: &ElementId,
    source: Option<&ImageSource>,
    em: gpui::Pixels,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let data = source.and_then(|source| {
        match resolve(&(id.clone(), "favicon").into(), source, window, cx) {
            Load::Ready(data) => Some(data),
            _ => None,
        }
    });
    let timing = Timing::token(
        Ds::get(cx),
        DsDuration::MotionFast,
        Easing::MotionEaseStandard,
    );
    let arrived = window.use_keyed_state((id.clone(), "favicon-at"), cx, |_, _| None::<u32>);
    if data.is_some() && arrived.read(cx).is_none() {
        arrived.update(cx, |at, _| *at = Some(gpui::animation_time_ms()));
    }
    let fade = super::motion::Transition {
        from: 0.,
        to: f32::from(data.is_some()),
        start_ms: arrived.read(cx).unwrap_or_default(),
    };
    let ds = Ds::get(cx);
    let side = em * 1.125; // DS: InlineReference.module.css:75
    let radius = ds.len(Length::RadiusControl) / 2.;
    let globe = div()
        .absolute()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .child(icon_px(Icon::Globe2, em * 0.95)); // DS: InlineReference.module.css:89
    let globe = fade.apply(
        globe,
        &timing,
        &Props {
            opacity: Some((1., 0.)),
            ..Default::default()
        },
    );
    let plate = data.map(|data| {
        div()
            .absolute()
            .size_full()
            .rounded(radius)
            .bg(ds.color(Color::FaviconPlate))
            .border(ds.len(Length::BorderHairline))
            .border_color(ds.color(Color::FaviconPlateLine))
            .p(em * 0.125) // DS: InlineReference.module.css:107
            .child(
                gpui::img(ImageSource::Render(data))
                    .size_full()
                    .object_fit(gpui::ObjectFit::Contain),
            )
    });
    let plate = plate.map(|plate| {
        fade.apply(
            plate,
            &timing,
            &Props {
                opacity: Some((0., 1.)),
                ..Default::default()
            },
        )
    });
    div()
        .relative()
        .flex_none()
        .size(side)
        .mr(ds.len(Length::Space1))
        .top(-em * 0.2) // `vertical-align: -0.2em` (gpui puts a box without text on its top edge)
        .child(globe)
        .children(plate)
        .into_any_element()
}

/// The pieces of an external link: the lead (icon and first character) and the rest, a
/// character each so the label wraps anywhere.
fn external_items(
    id: &ElementId,
    label: Option<SharedString>,
    href: SharedString,
    favicon: Option<&ImageSource>,
    em: gpui::Pixels,
    window: &mut Window,
    cx: &mut App,
) -> Vec<AnyElement> {
    let text = match label {
        Some(label) if !is_bare(&label, &href) => label.to_string(),
        _ => host_label(&href),
    };
    let hover = hover_state(id, window, cx);
    let hovered = *hover.read(cx);
    let slot = favicon_slot(id, favicon, em, window, cx);
    let ds = Ds::get(cx);
    let ink = ds.color(Color::AccentText);
    let piece = |index: usize, text: String| {
        let on = hover.clone();
        let mut el = div()
            .id(SharedString::from(format!("{id}-{index}")))
            .text_color(ink)
            .whitespace_nowrap()
            .on_hover(move |over, _, cx| {
                on.update(cx, |state, cx| {
                    *state = *over;
                    cx.notify();
                });
            })
            .child(text);
        if hovered {
            el = el.underline();
        }
        el.into_any_element()
    };
    let gap_width = space(window);
    let mut chars = text.chars();
    let first: String = chars.next().into_iter().collect();
    let lead = div()
        .flex()
        .items_baseline()
        .child(slot)
        .child(piece(0, first))
        .into_any_element();
    let mut items = vec![
        Tooltip::new((id.clone(), "tip"))
            .label(href)
            .wrap()
            .child(lead)
            .into_any_element(),
    ];
    // A space between label words is a margin (a text item's width drops trailing whitespace).
    let rest: Vec<char> = chars.collect();
    items.extend(
        rest.iter()
            .enumerate()
            .filter(|(_, c)| !c.is_whitespace())
            .map(|(n, c)| {
                let spaced = rest.get(n + 1).is_some_and(|next| next.is_whitespace());
                div()
                    .mr(if spaced { gap_width } else { px(0.) })
                    .child(piece(n + 1, c.to_string()))
                    .into_any_element()
            }),
    );
    items
}

impl RenderOnce for InlineReference {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        div()
            .flex()
            .flex_wrap()
            .items_baseline()
            .children(self.items(window, cx))
    }
}

enum Part {
    Text(SharedString),
    Reference(InlineReference),
}

/// Running text with references in it: wraps like a paragraph.
#[derive(IntoElement)]
pub struct InlineFlow {
    parts: Vec<Part>,
}

impl InlineFlow {
    pub fn new() -> Self {
        Self { parts: Vec::new() }
    }

    pub fn text(mut self, text: impl Into<SharedString>) -> Self {
        self.parts.push(Part::Text(text.into()));
        self
    }

    pub fn reference(mut self, reference: InlineReference) -> Self {
        self.parts.push(Part::Reference(reference));
        self
    }
}

impl Default for InlineFlow {
    fn default() -> Self {
        Self::new()
    }
}

/// Words, each with whether whitespace follows it (gpui drops trailing whitespace from the
/// width of a text item, so the space is a margin).
fn words(text: &str) -> Vec<(String, bool)> {
    let mut out: Vec<(String, bool)> = Vec::new();
    let mut in_space = false;
    for c in text.chars() {
        if c.is_whitespace() {
            in_space = true;
            if let Some(last) = out.last_mut() {
                last.1 = true;
            }
        } else {
            if in_space || out.is_empty() {
                out.push((String::new(), false));
                in_space = false;
            }
            if let Some(last) = out.last_mut() {
                last.0.push(c);
            }
        }
    }
    out
}

/// The advance of a space in the inherited font.
fn space(window: &mut Window) -> gpui::Pixels {
    let style = window.text_style();
    let size = style.font_size.to_pixels(window.rem_size());
    let font = window.text_system().resolve_font(&style.font());
    window
        .text_system()
        .advance(font, size, ' ')
        .map_or(size * 0.25, |advance| advance.width)
}

impl RenderOnce for InlineFlow {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let gap_width = space(window);
        let mut items = Vec::new();
        for part in self.parts {
            match part {
                Part::Text(text) => {
                    if text.starts_with(char::is_whitespace) {
                        items.push(div().w(gap_width).into_any_element());
                    }
                    items.extend(words(&text).into_iter().map(|(word, gap)| {
                        div()
                            .whitespace_nowrap()
                            .mr(if gap { gap_width } else { px(0.) })
                            .child(word)
                            .into_any_element()
                    }));
                }
                Part::Reference(reference) => items.extend(reference.items(window, cx)),
            }
        }
        div().flex().flex_wrap().items_baseline().children(items)
    }
}
