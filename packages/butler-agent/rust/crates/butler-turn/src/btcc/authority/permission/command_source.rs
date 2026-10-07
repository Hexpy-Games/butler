//! Borrow common command strings; retain the generic decoder for other input shapes.
use super::{
    AuthorityError, AuthorityResult, CommandScope, PermissionSource, PermissionTarget,
    source_grant_ref,
};
use butler_core::locale::LocaleCollation;
use serde::{Deserialize, Deserializer};
use serde_json::{Value, value::RawValue};
use std::{borrow::Cow, collections::HashMap};

#[derive(Deserialize)]
struct CommandInput<'a> {
    #[serde(borrow)]
    command: Cow<'a, str>,
    #[serde(default, borrow, deserialize_with = "present")]
    cwd: Option<&'a RawValue>,
    #[serde(default, borrow, deserialize_with = "present")]
    state_effect: Option<&'a RawValue>,
    // Decode other fields too, preserving Value's validation of arbitrary JSON.
    #[serde(flatten)]
    _extra: serde_json::Map<String, Value>,
}

fn present<'de, D: Deserializer<'de>>(de: D) -> Result<Option<&'de RawValue>, D::Error> {
    <&RawValue>::deserialize(de).map(Some)
}

#[derive(Deserialize)]
#[serde(transparent)]
struct Text<'a>(#[serde(borrow)] Cow<'a, str>);

pub(super) fn project(
    source: &PermissionSource<'_>,
    collation: &LocaleCollation,
    prefixes: &mut HashMap<String, HashMap<String, String>>,
    scope: &CommandScope,
) -> AuthorityResult<Option<PermissionTarget>> {
    let Ok(input) = serde_json::from_str::<CommandInput<'_>>(source.input_json) else {
        return Ok(None);
    };
    let cwd = if let Some(raw) = input.cwd {
        let Ok(text) = serde_json::from_str::<Text<'_>>(raw.get()) else {
            return Ok(None);
        };
        Some(text.0)
    } else {
        None
    };
    let effect = input
        .state_effect
        .map(|raw| serde_json::from_str::<Value>(raw.get()))
        .transpose()
        .map_err(|error| AuthorityError::policy("authority_request_corrupt").with_source(error))?;
    let key = scope.key_borrowed(&input.command, cwd.as_deref(), effect.as_ref(), collation)?;
    Ok(Some(PermissionTarget {
        grant_ref: source_grant_ref(source, &key, collation, prefixes)?,
        capability: source.capability.to_owned(),
        target: butler_core::public_text::sanitize_public_delta(&input.command),
        cwd: Some(cwd.as_deref().unwrap_or(source.workspace).to_owned()),
    }))
}
