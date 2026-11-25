//! Validation and the command-only snapshot for a sealed remote.
use super::sealed::{self, SealedError};
use parking_lot::{Mutex, RwLock};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, OnceLock},
};

const RESERVED_NAMES: &[&str] = &["BUTLER_*"];
const PREFIX: &str = "computer_env/";
static SNAPSHOT: OnceLock<RwLock<Arc<BTreeMap<String, String>>>> = OnceLock::new();
static UPDATES: Mutex<()> = Mutex::new(());

#[derive(Debug, thiserror::Error)]
pub enum EnvError {
    #[error("Enter a valid variable name.")]
    NameInvalid,
    #[error("This name can't be used.")]
    NameReserved,
    #[error("This variable name is already used.")]
    NameDuplicate,
    #[error("Enter a value for the variable.")]
    ValueRequired,
    #[error("Enter a valid variable value.")]
    ValueInvalid,
    #[error("Check this line.")]
    LineInvalid,
    #[error("A secret has this name.")]
    NameSecret,
    #[error("Add up to 64 variables.")]
    TooMany,
    #[error("The environment variables are too large.")]
    TooLarge,
}

impl EnvError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NameInvalid => "computer_env_name_invalid",
            Self::NameReserved => "computer_env_name_reserved",
            Self::NameDuplicate => "computer_env_name_duplicate",
            Self::ValueRequired => "computer_env_value_required",
            Self::ValueInvalid => "computer_env_value_invalid",
            Self::LineInvalid => "computer_env_line_invalid",
            Self::NameSecret => "computer_env_name_secret",
            Self::TooMany => "computer_env_too_many",
            Self::TooLarge => "computer_env_too_large",
        }
    }
}

pub fn check<'a>(
    entries: impl ExactSizeIterator<Item = (&'a str, &'a str)>,
) -> Result<(), EnvError> {
    if entries.len() > 64 {
        return Err(EnvError::TooMany);
    }
    let mut names = BTreeSet::new();
    let mut size = 0;
    for (name, value) in entries {
        check_name(name)?;
        if !names.insert(name) {
            return Err(EnvError::NameDuplicate);
        }
        check_value(value)?;
        size += name.len() + value.len() + 2;
    }
    if size > 256 * 1024 {
        return Err(EnvError::TooLarge);
    }
    Ok(())
}

fn check_name(name: &str) -> Result<(), EnvError> {
    let mut bytes = name.bytes();
    if name.len() > 128
        || !bytes
            .next()
            .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        || !bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err(EnvError::NameInvalid);
    }
    if RESERVED_NAMES
        .iter()
        .any(|rule| match rule.strip_suffix('*') {
            Some(prefix) => name.starts_with(prefix),
            None => name == *rule,
        })
    {
        return Err(EnvError::NameReserved);
    }
    Ok(())
}

fn check_value(value: &str) -> Result<(), EnvError> {
    if value.len() > 32 * 1024 || value.chars().any(|ch| ch.is_control() && ch != '\t') {
        return Err(EnvError::ValueInvalid);
    }
    Ok(())
}

/// Parse without modifying the text that the settings editor will reopen.
pub fn parse<'a>(
    text: &'a str,
    secrets: &BTreeSet<&str>,
) -> Result<BTreeMap<&'a str, &'a str>, (EnvError, Option<usize>)> {
    if text.len() > 64 * 1024 {
        return Err((EnvError::TooLarge, None));
    }
    let mut entries = BTreeMap::new();
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    for (index, line) in text.split('\n').enumerate() {
        let at_line = |error| (error, Some(index + 1));
        let Some((name, value)) = parse_line(line).map_err(at_line)? else {
            continue;
        };
        if entries.insert(name, value).is_some() {
            return Err(at_line(EnvError::NameDuplicate));
        }
        if secrets.contains(name) {
            return Err(at_line(EnvError::NameSecret));
        }
    }
    Ok(entries)
}

const SPACE: [char; 2] = [' ', '\t'];

fn parse_line(line: &str) -> Result<Option<(&str, &str)>, EnvError> {
    let line = line
        .strip_suffix('\r')
        .unwrap_or(line)
        .trim_start_matches(SPACE);
    if line.trim().is_empty() || line.starts_with('#') {
        return Ok(None);
    }
    let line = line
        .strip_prefix("export")
        .filter(|rest| rest.starts_with(SPACE))
        .map_or(line, |rest| rest.trim_start_matches(SPACE));
    let (name, value) = line.split_once('=').ok_or(EnvError::LineInvalid)?;
    let name = name.trim_matches(SPACE);
    check_name(name).map_err(|error| match error {
        EnvError::NameInvalid => EnvError::LineInvalid,
        other => other,
    })?;
    let value = parse_value(value)?;
    check_value(value).map_err(|_| EnvError::LineInvalid)?;
    Ok(Some((name, value)))
}

fn parse_value(raw: &str) -> Result<&str, EnvError> {
    let value = raw.trim_matches(SPACE);
    if let Some(quote) = value.chars().next().filter(|ch| matches!(ch, '"' | '\'')) {
        return value[1..].strip_suffix(quote).ok_or(EnvError::LineInvalid);
    }
    let comment = raw
        .as_bytes()
        .windows(2)
        .position(|pair| matches!(pair, [b' ' | b'\t', b'#']));
    Ok(raw[..comment.unwrap_or(raw.len())].trim_matches(SPACE))
}

pub fn current() -> Arc<BTreeMap<String, String>> {
    if sealed::is_enabled() {
        return SNAPSHOT.get_or_init(Default::default).read().clone();
    }
    Default::default()
}

#[derive(Debug, thiserror::Error)]
pub enum ReplaceError {
    #[error(transparent)]
    Invalid(#[from] EnvError),
    #[error(transparent)]
    Sealed(#[from] SealedError),
}

pub fn replace(variables: BTreeMap<String, String>) -> Result<(), ReplaceError> {
    check(
        variables
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str())),
    )?;
    let _update = UPDATES.lock();
    sealed::update_map(|map| {
        map.retain(|key, _| !key.starts_with(PREFIX));
        map.extend(
            variables
                .iter()
                .map(|(name, value)| (format!("{PREFIX}{name}"), value.clone())),
        );
        Some(())
    })?;
    publish(variables);
    Ok(())
}

pub fn load() -> Result<(), SealedError> {
    let _update = UPDATES.lock();
    publish(
        sealed::read_map()?
            .into_iter()
            .filter_map(|(key, value)| Some((key.strip_prefix(PREFIX)?.to_owned(), value)))
            .collect(),
    );
    Ok(())
}

fn publish(variables: BTreeMap<String, String>) {
    let mut snapshot = SNAPSHOT.get_or_init(Default::default).write();
    let previous = std::mem::replace(&mut *snapshot, Arc::new(variables));
    for (name, value) in snapshot.iter() {
        butler_log::register_secret_for(&format!("computer-env:{name}"), value);
    }
    for name in previous.keys().filter(|name| !snapshot.contains_key(*name)) {
        butler_log::register_secret_for(&format!("computer-env:{name}"), "");
    }
}
