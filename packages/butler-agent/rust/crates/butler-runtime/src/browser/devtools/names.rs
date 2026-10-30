//! Which names carry credentials: one list with the App, which reads the same
//! file (`electron/browser/credential-names.mjs`). A list that fails to load
//! reads every name as a credential.
use serde::Deserialize;
use std::sync::LazyLock;

#[derive(Deserialize)]
struct Names {
    substrings: Vec<String>,
    words: Vec<String>,
    url_substrings: Vec<String>,
    url_words: Vec<String>,
    url_names: Vec<String>,
    cookie_substrings: Vec<String>,
    password_fields: Vec<String>,
    own_cookie: String,
}

static NAMES: LazyLock<Option<Names>> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../../../../butler-app/client/electron/browser/page/credential-names.json"
    ))
    .ok()
});

fn words(name: &str) -> Vec<String> {
    let mut words = vec![String::new()];
    let mut previous_lower = false;
    for ch in name.chars() {
        if !ch.is_alphanumeric() {
            words.push(String::new());
            previous_lower = false;
            continue;
        }
        if ch.is_uppercase() && previous_lower {
            words.push(String::new());
        }
        previous_lower = ch.is_lowercase();
        if let Some(word) = words.last_mut() {
            word.extend(ch.to_lowercase());
        }
    }
    words
}

fn any_in(list: &[String], text: &str) -> bool {
    list.iter().any(|needle| text.contains(needle.as_str()))
}

/// Whether a header, field, attribute or parameter name carries a credential.
pub(crate) fn credential_name(name: &str) -> bool {
    let Some(names) = NAMES.as_ref() else {
        return true;
    };
    let lower = name.to_lowercase();
    any_in(&names.substrings, &lower)
        || lower.contains("auth") && !lower.contains("author")
        || lower.contains("authorization")
        || words(name).iter().any(|word| names.words.contains(word))
}

/// A request header that says it carries a sign-in. CSRF tokens go to anonymous
/// pages too, and cookies are read from the store.
pub(crate) fn credential_header(name: &str) -> bool {
    let lower = name.to_lowercase();
    credential_name(name)
        && !["csrf", "xsrf", "cookie"]
            .iter()
            .any(|skip| lower.contains(skip))
}

/// Query and fragment parameters that also carry one-time secrets in URLs.
pub(crate) fn secret_parameter(name: &str) -> bool {
    let Some(names) = NAMES.as_ref() else {
        return true;
    };
    let decoded: String = url::form_urlencoded::parse(name.as_bytes())
        .map(|(key, _)| key.into_owned())
        .collect();
    let lower = decoded.to_lowercase();
    credential_name(&decoded)
        || names.url_names.contains(&lower)
        || any_in(&names.url_substrings, &lower)
        || words(&decoded)
            .iter()
            .any(|word| names.url_words.contains(word))
}

/// Whether a cookie says someone may be signed in. A false positive only costs
/// an extra card, so anything HttpOnly counts. Butler's own preview cookie on a
/// loopback host is no login.
pub(crate) fn login_cookie(name: &str, http_only: bool, domain: &str) -> bool {
    let Some(names) = NAMES.as_ref() else {
        return true;
    };
    if name == names.own_cookie && super::local_url(&format!("http://{domain}/")) {
        return false;
    }
    http_only || credential_name(name) || any_in(&names.cookie_substrings, &name.to_lowercase())
}

/// Whether a field's accessible name says a password goes in it.
pub(crate) fn password_field(name: &str) -> bool {
    NAMES
        .as_ref()
        .is_none_or(|names| any_in(&names.password_fields, &name.to_lowercase()))
}
