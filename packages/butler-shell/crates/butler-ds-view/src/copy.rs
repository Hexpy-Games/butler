//! Showcase copy: every example's text in English and Korean, as the React showcases carry it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Lang {
    En,
    #[default]
    Ko,
}

impl Lang {
    /// The copy for this language out of an `(en, ko)` pair.
    pub(crate) fn pick<T>(self, en: T, ko: T) -> T {
        match self {
            Self::En => en,
            Self::Ko => ko,
        }
    }
}
