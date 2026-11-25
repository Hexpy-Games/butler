//! Validation and the command-only snapshot for a sealed remote.
use super::sealed::{self, SealedError};
use parking_lot::{Mutex, RwLock};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, OnceLock},
};

const PREFIX: &str = "computer_env/";
static SNAPSHOT: OnceLock<RwLock<Arc<BTreeMap<String, String>>>> = OnceLock::new();
static UPDATES: Mutex<()> = Mutex::new(());

#[derive(Debug, thiserror::Error)]
pub enum EnvError {
    #[error("Enter a valid variable name.")]
    NameInvalid,
    #[error("Butler uses this variable name.")]
    NameReserved,
    #[error("This variable name is already used.")]
    NameDuplicate,
    #[error("Enter a value for the variable.")]
    ValueRequired,
    #[error("Enter a valid variable value.")]
    ValueInvalid,
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
            Self::TooMany => "computer_env_too_many",
            Self::TooLarge => "computer_env_too_large",
        }
    }
}

pub fn check<'a>(
    entries: impl ExactSizeIterator<Item = (&'a str, Option<&'a str>)>,
) -> Result<(), EnvError> {
    if entries.len() > 64 {
        return Err(EnvError::TooMany);
    }
    let mut names = BTreeSet::new();
    let mut size = 0;
    for (name, value) in entries {
        let mut bytes = name.bytes();
        if name.len() > 128
            || !bytes
                .next()
                .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
            || !bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return Err(EnvError::NameInvalid);
        }
        if ["BUTLER_", "LD_", "DYLD_"]
            .iter()
            .any(|prefix| name.starts_with(prefix))
            || matches!(
                name,
                "HOME"
                    | "PATH"
                    | "TMPDIR"
                    | "TEMP"
                    | "TMP"
                    | "XDG_CACHE_HOME"
                    | "SSH_AUTH_SOCK"
                    | "LC_ALL"
                    | "BASH_ENV"
                    | "ENV"
            )
        {
            return Err(EnvError::NameReserved);
        }
        if !names.insert(name) {
            return Err(EnvError::NameDuplicate);
        }
        let value = value
            .filter(|value| !value.is_empty())
            .ok_or(EnvError::ValueRequired)?;
        if value.len() > 32 * 1024 || value.chars().any(|ch| ch.is_control() && ch != '\t') {
            return Err(EnvError::ValueInvalid);
        }
        size += name.len() + value.len() + 2;
    }
    if size > 256 * 1024 {
        return Err(EnvError::TooLarge);
    }
    Ok(())
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
            .map(|(name, value)| (name.as_str(), Some(value.as_str()))),
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
