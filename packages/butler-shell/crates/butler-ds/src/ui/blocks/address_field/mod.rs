//! DS AddressField (AddressField.tsx / AddressField.module.css, splitAddress.ts): the browser
//! toolbar's address. A security glyph, the bold host with a muted path truncating at the end,
//! tags and the bookmark star, in a pill one `--control-height-lg` tall. A click, Enter or Space
//! turns it into a text editor with the full URL selected; Enter submits, Escape and blur
//! cancel. A pure presenter: the app owns the URL, the security state, bookmarks and navigation,
//! and may control edit mode (`editing`, Cmd+L).
//!
//! The React `field` render prop of AddressSuggestions becomes `on_input` (the typed text on
//! every change), `on_key` (runs before the built-in keys) and [`focus_handle`] (where focus is
//! while editing); the suggestions popover is the product's.
mod edit;
mod split;

use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, IntoElement, KeyDownEvent, ParentElement as _, RenderOnce,
    SharedString, Styled as _, Window, div,
};

pub use edit::focus_handle;
pub use split::split_address;

use super::scope::{self, ActionScale, Spec};
use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::clickable::{Clickable, Variant};
use crate::ui::context::Ds;
use crate::ui::icon::{IconSize, icon};
use crate::ui::icon_button::IconButton;
use crate::ui::typo::{Role, Run, Tone, Typo, Weight};
use crate::ui::{focus, strut};
use edit::{Edit, KeyHook, SetEditing, Submit};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AddressSecurity {
    #[default]
    Secure,
    Insecure,
    Internal,
}

/// `AddressFieldLabels`: the field's words, English by default.
#[derive(Clone, Debug)]
pub struct AddressFieldLabels {
    /// The accessible name of the field.
    pub field: SharedString,
    pub placeholder: SharedString,
    pub secure: SharedString,
    pub insecure: SharedString,
    pub bookmark_add: SharedString,
    pub bookmarked: SharedString,
}

impl Default for AddressFieldLabels {
    fn default() -> Self {
        Self {
            field: "Address".into(),
            placeholder: "Search or enter URL".into(),
            secure: "Secure connection".into(),
            insecure: "Not secure".into(),
            bookmark_add: "Add bookmark".into(),
            bookmarked: "Bookmarked".into(),
        }
    }
}

type Plain = Rc<dyn Fn(&mut Window, &mut App)>;
type Editing = Rc<dyn Fn(bool, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct AddressField {
    id: ElementId,
    url: SharedString,
    title: Option<SharedString>,
    icon: Option<AnyElement>,
    security: AddressSecurity,
    tags: Vec<AnyElement>,
    bookmarked: bool,
    on_toggle_bookmark: Option<Plain>,
    on_submit: Option<Submit>,
    disabled: bool,
    editing: Option<bool>,
    on_editing_change: Option<Editing>,
    labels: AddressFieldLabels,
    on_input: Option<edit::Input>,
    on_key: Option<KeyHook>,
}

impl AddressField {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            url: SharedString::default(),
            title: None,
            icon: None,
            security: AddressSecurity::Secure,
            tags: Vec::new(),
            bookmarked: false,
            on_toggle_bookmark: None,
            on_submit: None,
            disabled: false,
            editing: None,
            on_editing_change: None,
            labels: AddressFieldLabels::default(),
            on_input: None,
            on_key: None,
        }
    }

    /// The page URL: the bold host and the muted path at rest, edited in full. Empty shows the
    /// placeholder.
    pub fn url(mut self, url: impl Into<SharedString>) -> Self {
        self.url = url.into();
        self
    }

    /// A Butler page's name (the library) in place of the host; pair it with `icon`.
    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// Replaces the security glyph (a Butler page's icon).
    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    pub fn security(mut self, security: AddressSecurity) -> Self {
        self.security = security;
        self
    }

    /// A tag before the star (signed in, Butler output, preview): a `Tag` of size `sm`.
    pub fn tag(mut self, tag: impl IntoElement) -> Self {
        self.tags.push(tag.into_any_element());
        self
    }

    pub fn bookmarked(mut self, bookmarked: bool) -> Self {
        self.bookmarked = bookmarked;
        self
    }

    /// Shows the star; omit for pages that cannot be bookmarked.
    pub fn on_toggle_bookmark(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_toggle_bookmark = Some(Rc::new(handler));
        self
    }

    /// Enter in edit mode, with the trimmed text; omit to make the field read-only.
    pub fn on_submit(mut self, handler: impl Fn(String, &mut Window, &mut App) + 'static) -> Self {
        self.on_submit = Some(Rc::new(handler));
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    /// Controlled edit mode (Cmd+L); omit to let a click toggle it.
    pub fn editing(mut self, editing: bool) -> Self {
        self.editing = Some(editing);
        self
    }

    pub fn on_editing_change(
        mut self,
        handler: impl Fn(bool, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_editing_change = Some(Rc::new(handler));
        self
    }

    pub fn labels(mut self, labels: AddressFieldLabels) -> Self {
        self.labels = labels;
        self
    }

    /// The typed text while editing, on every change.
    pub fn on_input(mut self, handler: impl Fn(String, &mut Window, &mut App) + 'static) -> Self {
        self.on_input = Some(Rc::new(handler));
        self
    }

    /// Runs before the built-in keys; return `true` to take the key (a highlighted suggestion
    /// takes Enter, an open list the first Escape).
    pub fn on_key(
        mut self,
        handler: impl Fn(&KeyDownEvent, &mut Window, &mut App) -> bool + 'static,
    ) -> Self {
        self.on_key = Some(Rc::new(handler));
        self
    }
}

impl AddressField {
    fn glyph(&mut self, ds: &Ds) -> AnyElement {
        let color = if self.security == AddressSecurity::Insecure {
            ds.color(Color::ColorWarningText)
        } else {
            ds.color(Color::TextTertiary)
        };
        let glyph = self.icon.take().unwrap_or_else(|| {
            let which = match self.security {
                AddressSecurity::Insecure => Icon::Warning,
                AddressSecurity::Internal => Icon::Globe2,
                AddressSecurity::Secure => Icon::Lock,
            };
            icon(which, IconSize::Md, ds).into_any_element()
        });
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .w(ds.len(Length::IconSizeMd))
            .text_color(color)
            .child(glyph)
            .into_any_element()
    }

    /// The text at rest: bold host, muted path, or the placeholder.
    fn display(&self, set_editing: &SetEditing, ds: &Ds) -> AnyElement {
        let (host, path) = split_address(&self.url);
        // `.host` and `.path` set their own colours; a disabled field keeps its own (`inherit`).
        let primary = if self.disabled {
            Tone::Inherit
        } else {
            Tone::Primary
        };
        let text = if let Some(title) = &self.title {
            Typo::new(Role::Text, title.clone())
                .weight(Weight::Medium)
                .tone(primary)
        } else if host.is_empty() {
            Typo::new(Role::Text, self.labels.placeholder.clone()).tone(Tone::Inherit)
        } else {
            Typo::runs(
                Role::Text,
                [
                    Run::new(host).weight(Weight::Medium).tone(primary),
                    Run::new(path).tone(Tone::Tertiary),
                ],
            )
        };
        let placeholder = self.title.is_none() && self.url.trim().is_empty();
        // The button face is 16px; the field's text is `--font-size-2` (the CSS spans inherit it
        // from `.field`).
        let text = div()
            .min_w_0()
            .text_size(ds.len(Length::FontSize2))
            .line_height(ds.len(Length::TypoLabelLineHeightTight))
            .when_placeholder(placeholder, ds.color(Color::Placeholder))
            .child(text.truncate());
        let open = set_editing.clone();
        let click = Clickable::new((self.id.clone(), "display"))
            .variant(Variant::Text)
            .stretch()
            .on_click(move |_, window, cx| open(true, window, cx))
            .child(text);
        let click = if self.disabled || self.on_submit.is_none() {
            click.disabled()
        } else {
            click
        };
        div()
            .flex()
            .flex_auto()
            .min_w_0()
            .h_full()
            .items_center()
            .child(click)
            .into_any_element()
    }

    fn star(&mut self, ds: &Ds) -> Option<AnyElement> {
        let toggle = self.on_toggle_bookmark.clone()?;
        let side = f32::from(ds.len(Length::ControlHeightSm));
        let label = if self.bookmarked {
            self.labels.bookmarked.clone()
        } else {
            self.labels.bookmark_add.clone()
        };
        let mut star = IconButton::new((self.id.clone(), "star"), label)
            .glyph(if self.bookmarked {
                Icon::StarFilled
            } else {
                Icon::Star
            })
            .pressed(self.bookmarked)
            .on_click(move |_, window, cx| toggle(window, cx));
        if self.disabled {
            star = star.disabled();
        }
        let scale = ActionScale {
            side,
            icon: f32::from(ds.len(Length::IconSizeMd)),
            fixed: false,
        };
        // `.star[aria-pressed="true"]`: the accent at rest.
        if self.bookmarked {
            star = star.inherit_color(ds.color(Color::AccentText));
        }
        Some(
            div()
                .flex_none()
                .child(scope::scoped(
                    Spec {
                        action: Some(scale),
                        ..Spec::default()
                    },
                    star,
                ))
                .into_any_element(),
        )
    }
}

/// `when` for a text colour that only a placeholder takes.
trait PlaceholderColor: gpui::Styled + Sized {
    fn when_placeholder(self, on: bool, color: gpui::Hsla) -> Self {
        if on { self.text_color(color) } else { self }
    }
}

impl PlaceholderColor for gpui::Div {}

impl RenderOnce for AddressField {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let own = window.use_keyed_state((self.id.clone(), "editing"), cx, |_, _| false);
        let editing =
            !self.disabled && self.on_submit.is_some() && self.editing.unwrap_or(*own.read(cx));
        let changed = self.on_editing_change.clone();
        let set_editing: SetEditing = Rc::new(move |next, window, cx| {
            own.update(cx, |state, _| *state = next);
            if let Some(changed) = &changed {
                changed(next, window, cx);
            }
            window.refresh();
        });
        let ds = Ds::get(cx);
        let glyph = self.glyph(ds);
        let body = if editing {
            let edit = Edit {
                id: self.id.clone(),
                url: self.url.clone(),
                placeholder: self.labels.placeholder.clone(),
                submit: self.on_submit.clone(),
                set_editing: set_editing.clone(),
                on_input: self.on_input.clone(),
                on_key: self.on_key.clone(),
            };
            edit::editor(edit, window, cx)
        } else {
            edit::reset(&self.id, window, cx);
            self.display(&set_editing, Ds::get(cx))
        };
        let ds = Ds::get(cx);
        let tags = (!editing && !self.tags.is_empty()).then(|| {
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(ds.len(Length::SpaceXs))
                .children(std::mem::take(&mut self.tags))
        });
        let star = if editing { None } else { self.star(ds) };
        let mut field = div()
            .flex()
            .flex_auto()
            .min_w_0()
            .h(ds.len(Length::ControlHeightLg))
            .items_center()
            .gap(ds.len(Length::SpaceSm))
            .pl(ds.len(Length::SpaceMd))
            .pr(ds.len(Length::SpaceXs))
            .rounded(ds.len(Length::RadiusPill))
            .bg(ds.color(Color::Selection))
            .text_color(if self.disabled {
                ds.color(Color::InteractiveDisabledFg)
            } else {
                ds.color(Color::TextPrimary)
            })
            .text_size(ds.len(Length::FontSize2))
            .line_height(ds.len(Length::TypoLabelLineHeightTight));
        if editing {
            field = field
                .bg(ds.color(Color::SurfaceRaised))
                .shadow(focus::shadows(ds));
        }
        strut::scope(
            false,
            field.child(glyph).child(body).children(tags).children(star),
        )
    }
}
