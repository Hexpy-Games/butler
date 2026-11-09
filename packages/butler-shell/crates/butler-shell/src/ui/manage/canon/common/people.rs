//! `localPerson.ts`, `useCanonPersonName.ts`, `canonActorLabel.ts`, `CanonAvatar.tsx` and
//! `CanonPersonSelect.tsx`.
use butler_ds::ui::Icon;
use butler_ds::ui::avatar::{Avatar, AvatarSize, AvatarTone};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::native_select::NativeSelect;
use gpui::{AnyElement, App, ElementId, Global, IntoElement as _, SharedString, Window};
use serde::Deserialize;

use super::copy::words;
use super::form::styled;
use super::{LOCAL_PERSON_ID, OnSelect, SelectOpts};
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::{CanonActor, CanonAgent};

/// The personalization name, read once (the store's `personalization`, which
/// `useCanonPersonName` loads when it is not there yet).
#[derive(Default)]
struct PersonName {
    name: Option<SharedString>,
    loaded: bool,
    loading: bool,
}

impl Global for PersonName {}

/// The slice of `GET /personalization` the name comes from.
#[derive(Default, Deserialize)]
#[serde(default)]
struct Personalization {
    profile: Profile,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Profile {
    principal_name: String,
}

/// Starts the one read of the personalization name (the effect of `useCanonPersonName`). Entities
/// that show people call it when they are built; a name that is not there yet reads as "Me".
pub(crate) fn warm_person_name(cx: &mut App) {
    let state = cx.default_global::<PersonName>();
    if state.loaded || state.loading {
        return;
    }
    state.loading = true;
    let request = Jobs::run(
        cx,
        |client| async move { client.get_personalization().await },
    );
    cx.spawn(async move |cx| {
        let view = request
            .await
            .and_then(Result::ok)
            .and_then(|raw| serde_json::from_value::<Personalization>(raw).ok());
        cx.update(|cx| {
            let state = cx.default_global::<PersonName>();
            state.loading = false;
            let Some(view) = view else { return };
            state.loaded = true;
            let name = view.profile.principal_name.trim();
            state.name = (!name.is_empty()).then(|| SharedString::from(name.to_owned()));
            cx.refresh_windows();
        });
    })
    .detach();
}

/// `useCanonPersonName`
pub(crate) fn person_name(cx: &App) -> SharedString {
    cx.try_global::<PersonName>()
        .and_then(|state| state.name.clone())
        .unwrap_or_else(|| words(Ds::get(cx).lang()).me.into())
}

/// `personLabel`
pub(crate) fn person_label(id: Option<&str>, lang: Lang) -> SharedString {
    let copy = words(lang);
    match id {
        Some(LOCAL_PERSON_ID) => copy.me.into(),
        Some(id) => id.to_owned().into(),
        None => copy.none.into(),
    }
}

/// `canonActorLabel`
pub(crate) fn actor_label(actor: &CanonActor, local: &str, lang: Lang) -> SharedString {
    let copy = words(lang);
    let via = actor.via.as_deref().filter(|via| !via.is_empty());
    let mcp = actor.origin.as_deref() == Some("mcp");
    if !mcp && via == Some("butler") {
        return copy.mcp_butler.into();
    }
    let person = match actor.person.as_deref() {
        Some(LOCAL_PERSON_ID) => local,
        Some(person) if !person.is_empty() => person,
        _ => copy.me,
    };
    match via {
        Some(via) if mcp || via != "app" => format!("{person} · {via}").into(),
        _ => person.to_owned().into(),
    }
}

/// `CanonAvatar`
pub(crate) fn canon_avatar(
    person: Option<&str>,
    agent: Option<&CanonAgent>,
    cx: &App,
) -> Option<AnyElement> {
    let person = agent
        .map(|agent| agent.person.as_str())
        .or(person)
        .filter(|person| !person.is_empty())?;
    let lang = Ds::get(cx).lang();
    let own = person == LOCAL_PERSON_ID;
    let name = if own {
        person_name(cx)
    } else {
        person_label(Some(person), lang)
    };
    let copy = words(lang);
    let label = match agent {
        Some(agent) => (copy.mcp_working)(&name, &agent.via),
        None => (copy.person_label)(&name, own),
    };
    let tone = if own {
        AvatarTone::Own
    } else {
        AvatarTone::Other
    };
    Some(
        Avatar::new(SharedString::from(format!("canon-avatar-{person}")), name)
            .size(AvatarSize::Xs)
            .tone(tone)
            .badge(agent.map(|_| Icon::Bot))
            .label(label)
            .into_any_element(),
    )
}

/// `CanonPersonSelect`
pub(crate) fn person_select(
    id: impl Into<ElementId>,
    value: Option<SharedString>,
    opts: SelectOpts,
    on_change: OnSelect,
    _window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    warm_person_name(cx);
    let lang = Ds::get(cx).lang();
    let value = value.filter(|value| !value.is_empty());
    let current = value
        .as_ref()
        .map_or_else(|| "none".to_owned(), |value| format!("person:{value}"));
    let mut select = NativeSelect::new(id)
        .value(current)
        .option("none", words(lang).none)
        .option(
            format!("person:{LOCAL_PERSON_ID}"),
            person_label(Some(LOCAL_PERSON_ID), lang),
        );
    if let Some(other) = value.filter(|value| value != LOCAL_PERSON_ID) {
        select = select.option(format!("person:{other}"), person_label(Some(&other), lang));
    }
    styled(select, opts)
        .on_change(move |picked, window, cx| {
            let person = picked
                .strip_prefix("person:")
                .map(|person| SharedString::from(person.to_owned()));
            on_change(person, window, cx);
        })
        .into_any_element()
}
