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
            return Err(LocaleError("Expected a resolved BCP-47 locale".into()));
        }
        let locale: Locale = locale
            .parse()
            .map_err(|error| LocaleError(format!("{error}")))?;
        let mut options = CollatorOptions::new();
        options.strength = Some(Strength::Tertiary);
        let collator = Collator::try_new(&locale.into(), options)
            .map_err(|error| LocaleError(error.to_string()))?;
        Ok(Self { collator })
    }

    pub(crate) fn compare(&self, left: &str, right: &str) -> Ordering {
        self.collator.compare(left, right)
    }
}

#[derive(Debug)]
pub(crate) struct LocaleError(String);

impl std::fmt::Display for LocaleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for LocaleError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Fixture {
        inputs: Vec<String>,
        locales: Vec<LocaleFixture>,
    }
    #[derive(Deserialize)]
    struct LocaleFixture {
        locale: String,
        comparisons: Vec<i8>,
    }

    #[test]
    fn matches_bun_locale_compare_for_evidence_references() {
        let fixture: Fixture =
            serde_json::from_str(include_str!("locale/bun-collation-fixture.json")).unwrap();
        for locale in fixture.locales {
            let collator = LocaleCollation::new(&locale.locale).unwrap();
            for (left_index, left) in fixture.inputs.iter().enumerate() {
                for (right_index, right) in fixture.inputs.iter().enumerate() {
                    let expected =
                        locale.comparisons[left_index * fixture.inputs.len() + right_index];
                    let actual = match collator.compare(left, right) {
                        Ordering::Less => -1,
                        Ordering::Equal => 0,
                        Ordering::Greater => 1,
                    };
                    assert_eq!(actual, expected, "{} {left:?} / {right:?}", locale.locale);
                }
            }
        }
    }

    #[test]
    fn rejects_invalid_locale_and_supports_shared_native_ownership() {
        assert!(LocaleCollation::new("not_a_valid_locale!").is_err());
        fn assert_shared<T: Send + Sync>() {}
        assert_shared::<LocaleCollation>();
    }
}
