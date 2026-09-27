//! Collation with compiled ICU4X 1.4 / CLDR 44 data.
//! Bounded Bun fixtures establish compatibility; source ICU is independently versioned.
//! The host supplies its resolved locale once; comparisons perform no I/O.

use std::cmp::Ordering;

use icu_collator::{Collator, CollatorOptions, Strength};
use icu_locid::Locale;

pub(crate) struct LocaleCollation {
    collator: Collator,
}

impl LocaleCollation {
    /// Provenance for the exactly pinned native implementation. ICU4X has its
    /// own release version; this must never masquerade as Bun's ICU4C version.
    pub(crate) fn implementation_version() -> &'static str {
        "ICU4X 1.4.0"
    }

    pub(crate) fn new(locale: &str) -> Result<Self, LocaleError> {
        // Host input is a resolved BCP-47 locale, not an ICU/POSIX locale ID.
        // ICU4X also accepts underscore separators; do not silently accept them.
        if locale.is_empty()
            || locale
                .bytes()
                .any(|byte| !byte.is_ascii_alphanumeric() && byte != b'-')
        {
            return Err(LocaleError::NotBcp47);
        }
        let locale: Locale = locale.parse().map_err(LocaleError::Parse)?;
        let mut options = CollatorOptions::new();
        options.strength = Some(Strength::Tertiary);
        let collator = Collator::try_new(&locale.into(), options).map_err(LocaleError::Collator)?;
        Ok(Self { collator })
    }

    pub(crate) fn compare(&self, left: &str, right: &str) -> Ordering {
        self.collator.compare(left, right)
    }
}

/// Failures to build a collator for the host's locale.
#[derive(Debug, thiserror::Error)]
pub(crate) enum LocaleError {
    /// The input is empty or uses characters outside BCP-47 (e.g. `_`).
    #[error("Expected a resolved BCP-47 locale")]
    NotBcp47,
    /// ICU4X could not parse the locale. (ICU4X 1.4 errors implement only
    /// `Display`, so they are kept as typed fields rather than sources.)
    #[error("{0}")]
    Parse(icu_locid::ParserError),
    /// ICU4X has no collation data for the locale.
    #[error("{0}")]
    Collator(icu_collator::CollatorError),
}
