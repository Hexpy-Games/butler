//! The language the App shows its text in.

/// The App's display language: Settings `language`, else `user.language` of
/// butler.config.json, else English.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum UiLanguage {
    #[default]
    English,
    Korean,
}

impl UiLanguage {
    /// The language a stored setting names (`en` or `ko`).
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "en" => Some(Self::English),
            "ko" => Some(Self::Korean),
            _ => None,
        }
    }

    /// The setting's wire value.
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::English => "en",
            Self::Korean => "ko",
        }
    }
}
