//! The mention menu's copy.
use crate::ui::i18n::Locale;

/// composer.mentionProject.
pub(crate) fn project_label(locale: Locale) -> &'static str {
    match locale {
        Locale::Ko => "프로젝트",
        Locale::En => "Project",
    }
}
