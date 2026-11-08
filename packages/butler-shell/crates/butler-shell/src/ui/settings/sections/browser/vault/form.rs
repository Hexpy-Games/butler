//! The drafts of the add/edit forms and the controls they share. A draft holds what the owner
//! typed; a secret leaves it at the moment of the request (`take`), so it is never kept after.
use std::collections::HashMap;

use butler_ds::ui::blocks::card_list::CardListItem;
use butler_ds::ui::blocks::overflow_action_menu::{OverflowActionMenu, OverflowItem};
use butler_ds::ui::button::{self, Button, Size as ButtonSize, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::field::FieldLabel;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Columns, Grid, Preset, Responsive, Space, Stack};
use butler_ds::ui::text::Input;
use butler_ds::ui::tooltip::Tooltip;
use gpui::{
    AnyElement, App, ClickEvent, Entity, IntoElement as _, ParentElement as _, SharedString, Window,
};
use serde_json::{Map, Value};

use super::actions::ask;
use super::copy::Words;
use super::{BrowserVault, Kind, Target};
use crate::ui::Icon;

/// Which draft a field belongs to.
#[derive(Clone, Copy, Debug)]
pub(super) enum FormId {
    SignIn,
    Card,
    Profile,
}

/// `VaultProfileForm`'s DETAILS: sent on every save, shown or not.
pub(super) const DETAILS: [&str; 18] = [
    "name",
    "family_name",
    "given_name",
    "name_latin",
    "name_latin_surname",
    "name_latin_given",
    "organization",
    "country",
    "postal_code",
    "region",
    "city",
    "address_line1",
    "address_line2",
    "nationality",
    "issuing_country",
    "passport_expiry",
    "phone",
    "email",
];

#[derive(Default)]
pub(super) struct Form {
    values: HashMap<&'static str, String>,
    pub(super) gender: String,
    pub(super) id_open: bool,
}

impl Form {
    pub(super) fn text(&self, key: &str) -> &str {
        self.values.get(key).map_or("", String::as_str)
    }

    pub(super) fn set(&mut self, key: &'static str, text: &str) {
        self.values.insert(key, text.to_owned());
    }

    /// A secret leaves the draft here.
    pub(super) fn take(&mut self, key: &str) -> String {
        self.values.remove(key).unwrap_or_default()
    }

    /// `[month, year]` of "MM/YY", empty when missing.
    pub(super) fn expiry(&self) -> (String, String) {
        let mut parts = self
            .text("expiry")
            .split('/')
            .map(|part| part.trim().to_owned());
        (
            parts.next().unwrap_or_default(),
            parts.next().unwrap_or_default(),
        )
    }

    /// `ready` of `VaultCardForm`: a number (kept when changing) and an expiry.
    pub(super) fn card_ready(&self, existing: bool) -> bool {
        let (month, year) = self.expiry();
        (existing || !self.text("number").trim().is_empty())
            && !month.is_empty()
            && !year.is_empty()
    }

    /// `ready` of `VaultProfileForm`: a profile name or a full name.
    pub(super) fn profile_ready(&self) -> bool {
        !self.text("nickname").trim().is_empty() || !self.text("name").trim().is_empty()
    }

    /// `input()` of `VaultCardForm`; the secrets are taken, empty ones left out.
    pub(super) fn card_body(&mut self) -> Value {
        let (month, year) = self.expiry();
        let number = |text: &str| text.parse::<u32>().map_or(Value::Null, Value::from);
        let mut out = Map::new();
        out.insert("nickname".into(), self.text("nickname").trim().into());
        out.insert("exp_month".into(), number(&month));
        out.insert("exp_year".into(), number(&year));
        out.insert("holder_name".into(), self.text("holder").trim().into());
        for key in ["number", "cvc", "pin2", "owner_id"] {
            let secret = self.take(key);
            if !secret.trim().is_empty() {
                out.insert(key.into(), secret.trim().into());
            }
        }
        Value::Object(out)
    }

    /// `save()` of `VaultProfileForm`; the secrets are taken, empty ones left out.
    pub(super) fn profile_body(&mut self) -> Value {
        let name = self.text("name").trim().to_owned();
        let nickname = self.text("nickname").trim().to_owned();
        let mut out = Map::new();
        out.insert(
            "nickname".into(),
            if nickname.is_empty() { name } else { nickname }.into(),
        );
        out.insert("gender".into(), self.gender.clone().into());
        for key in DETAILS {
            out.insert(key.into(), self.text(key).into());
        }
        for key in ["birth_date", "passport_number"] {
            let secret = self.take(key);
            if !secret.trim().is_empty() {
                out.insert(key.into(), secret.trim().into());
            }
        }
        Value::Object(out)
    }
}

/// A text field of draft `form`.
pub(super) fn input(
    this: &Entity<BrowserVault>,
    form: FormId,
    draft: &Form,
    key: &'static str,
    placeholder: impl Into<SharedString>,
) -> Input {
    let this = this.clone();
    Input::new(SharedString::from(format!("vault-{form:?}-{key}")))
        .placeholder(placeholder)
        .value(draft.text(key).to_owned())
        .on_change(move |text, _, cx| {
            this.update(cx, |this, cx| {
                this.form_mut(form).set(key, text);
                cx.notify();
            });
        })
}

/// A field for a secret (a password, a card or identity number).
// React's `type="password"`; the text leaves the draft at the request (`Form::take`).
pub(super) fn secret_input(
    this: &Entity<BrowserVault>,
    form: FormId,
    draft: &Form,
    key: &'static str,
    placeholder: impl Into<SharedString>,
) -> Input {
    input(this, form, draft, key, placeholder).masked()
}

/// `Field` + `FieldLabel` + the input.
pub(super) fn labeled(label: &str, input: Input) -> Stack {
    Stack::new()
        .gap(Space::Xs)
        .child(FieldLabel::new().child(SharedString::from(label.to_owned())))
        .child(input)
}

/// Two fields side by side; `stacks` puts them in one column when the page is compact
/// (`<Grid columns={{ base: "2", compact: "1" }} gap="sm">`).
pub(super) fn pair(
    id: &'static str,
    stacks: bool,
    a: impl gpui::IntoElement,
    b: impl gpui::IntoElement,
) -> Grid {
    Grid::new(id)
        .columns(Columns::Responsive(Responsive {
            compact: stacks.then_some(1),
            base: Preset::Fixed(2),
            wide: None,
        }))
        .gap(Space::Sm)
        .page_container()
        .child(a)
        .child(b)
}

/// The Add button of a list section, named by a tooltip (unavailable without the password store).
pub(super) fn add_button(
    id: &'static str,
    words: &Words,
    available: bool,
    enabled: bool,
    ds: &Ds,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let mut add = Button::new(id)
        .size(ButtonSize::Sm)
        .variant(Variant::Outline)
        .icon_start(icon(Icon::Plus, IconSize::Sm, ds))
        .text(words.add)
        .on_click(on_click);
    if !enabled {
        add = add.disabled();
    }
    Tooltip::new(format!("{id}-tip"))
        .label(if available {
            words.add
        } else {
            words.unavailable
        })
        .child(add)
        .into_any_element()
}

/// Cancel and Save, at the end of a form.
pub(super) fn form_buttons(
    id: &'static str,
    words: &Words,
    save_enabled: bool,
    on_cancel: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    on_save: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stack {
    let mut save = Button::new(format!("{id}-save"))
        .size(ButtonSize::Sm)
        .text(words.save)
        .on_click(on_save);
    if !save_enabled {
        save = save.disabled();
    }
    button::container(ButtonSize::Sm)
        .child(
            Button::new(format!("{id}-cancel"))
                .size(ButtonSize::Sm)
                .variant(Variant::Outline)
                .text(words.cancel)
                .on_click(on_cancel),
        )
        .child(save)
}

/// A row of a card list with the controls under it.
// CARVE-OUT(G-card): React puts these in `CardListItem`'s `description` node; D1's
// `description` is text, so they sit under the item. If D1 takes an element, move `extra` there.
pub(super) fn with_extra(item: CardListItem, extra: Stack) -> AnyElement {
    Stack::new()
        .gap(Space::Sm)
        .child(item)
        .child(extra)
        .into_any_element()
}

/// The Show number / Hide button of a row. The number only shows when the system can ask the
/// owner first (`reveal_available`).
pub(super) fn reveal_button(
    this: &Entity<BrowserVault>,
    kind: Kind,
    id: &str,
    state: (bool, bool, bool),
    words: &Words,
) -> AnyElement {
    let (shown, revealing, revealable) = state;
    let (this, key) = (this.clone(), id.to_owned());
    let mut button = Button::new(format!("vault-reveal-{id}"))
        .size(ButtonSize::Sm)
        .variant(Variant::Outline)
        .text(if shown { words.hide } else { words.reveal })
        .on_click(move |_, _, cx| {
            this.update(cx, |this, cx| {
                if shown {
                    this.hide(&SharedString::from(key.clone()), cx);
                } else {
                    this.reveal(kind, key.clone(), cx);
                }
            });
        });
    if !revealable || revealing {
        button = button.disabled();
    }
    let label = match (revealable, shown) {
        (false, _) => words.reveal_unavailable,
        (true, true) => words.hide,
        (true, false) => words.reveal,
    };
    Tooltip::new(format!("vault-reveal-{id}-tip"))
        .label(label)
        .child(button)
        .into_any_element()
}

/// The menu of a card or profile row: edit, delete (after its confirmation).
pub(super) fn item_menu(
    this: &Entity<BrowserVault>,
    kind: Kind,
    id: &str,
    nickname: &str,
    words: &'static Words,
) -> OverflowActionMenu {
    let (edit, remove) = (this.clone(), this.clone());
    let (edit_id, remove_id, name) = (id.to_owned(), id.to_owned(), nickname.to_owned());
    OverflowActionMenu::new(format!("vault-menu-{id}"), nickname.to_owned())
        .item(OverflowItem::new(words.edit).on_select(move |_, cx| {
            edit.update(cx, |this, cx| {
                this.open_form(kind, Target::Item(edit_id.clone()), cx);
            });
        }))
        .item(OverflowItem::new(words.delete).on_select(move |_, cx| {
            let (id, message) = (remove_id.clone(), (words.delete_confirm)(&name));
            let ctx = remove.read(cx).ctx.clone();
            ask(
                &ctx,
                &remove,
                message,
                words.delete,
                move |this, cx| this.remove_item(kind, id, cx),
                cx,
            );
        }))
}
