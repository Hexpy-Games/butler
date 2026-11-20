//! The clock of the activity time: Electron's `Intl.DateTimeFormat(undefined, ...)` hour cycle.

/// How the application locale writes the time of day.
#[derive(Debug, PartialEq)]
enum Clock {
    /// `ko`: `오전 12:48:13`
    Korean12,
    /// `en-US`: `12:48:13 AM`
    English12,
    /// `en-GB` and the shipped languages whose CLDR hour cycle is 24-hour: `00:48:13`
    Hour24,
}

/// The English regions Chromium maps to its `en-GB` UI locale. `GetPlatformLanguageMatcher`
/// matches a tag by ICU4X's CLDR fallback chain (`en-XX` -> `en-001` -> `en`), and `en-001`
/// belongs to `en-GB` (`GetEdgeWeight`: `en-001` -> `en-GB`, 0.8; `en` -> `en-US`, 0.8 beats
/// `en` -> `en-GB`, 0.9). So the regions CLDR's `parentLocale` data puts under `en_001` or
/// `en_150` (supplementalData.xml) match `en-GB`, as does `en-CA` (added explicitly); `en-LR` and
/// `en-PH` are added explicitly to `en-US`. Every other region, and plain `en`, matches `en-US`.
const ENGLISH_GB_REGIONS: [&str; 111] = [
    "001", "150", "AG", "AI", "AT", "AU", "BB", "BE", "BM", "BS", "BW", "BZ", "CA", "CC", "CH",
    "CK", "CM", "CX", "CY", "CZ", "DE", "DG", "DK", "DM", "EE", "ER", "ES", "FI", "FJ", "FK", "FM",
    "FR", "GB", "GD", "GE", "GG", "GH", "GI", "GM", "GS", "GY", "HK", "HU", "ID", "IE", "IL", "IM",
    "IN", "IO", "IT", "JE", "JM", "KE", "KI", "KN", "KY", "LC", "LS", "LT", "LV", "MG", "MO", "MS",
    "MT", "MU", "MV", "MW", "MY", "NA", "NF", "NG", "NL", "NO", "NR", "NU", "NZ", "PG", "PK", "PL",
    "PN", "PT", "PW", "RO", "RW", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SK", "SL", "SS", "SX",
    "SZ", "TC", "TK", "TO", "TT", "TV", "TZ", "UA", "UG", "VC", "VG", "VU", "WS", "ZA", "ZM", "ZW",
];

/// The languages of Chromium's desktop UI locales (`all_chrome_locales` minus
/// `extended_locales` in `build/config/locales.gni`, the `locales/*.pak` Electron ships).
/// Besides `ko` and `en` (mapped to their own text), the languages listed here are drawn 24-hour,
/// which is right for all but their 12-hour CLDR locales (am, ar, bn, el, es-419, fil, gu, hi, kn,
/// ml, mr, ms, ta, te, ur, zh-TW), whose AM/PM text Butler does not format. A language Chromium
/// does not ship has no match and the application locale falls back to `en-US`.
const UI_LANGUAGES: [&str; 48] = [
    "am", "ar", "bg", "bn", "ca", "cs", "da", "de", "el", "es", "et", "fa", "fi", "fil", "fr",
    "gu", "he", "hi", "hr", "hu", "id", "it", "ja", "kn", "lt", "lv", "ml", "mr", "ms", "nb", "nl",
    "pl", "pt", "ro", "ru", "sk", "sl", "sr", "sv", "sw", "ta", "te", "th", "tr", "uk", "ur", "vi",
    "zh",
];

/// The clock of the application locale Chromium resolves from the OS preferred language
/// (`l10n_util::GetApplicationLocale`): the renderer's ICU default, so `Intl.DateTimeFormat(
/// undefined)`, follows it. The tag is normalised (`ko_KR.UTF-8`, `en_GB@euro`, `zh-Hans-CN`).
/// macOS passes the first preferred localization, Windows the UI language list, Linux the
/// `LANGUAGE`/`LC_*`/`LANG` variables; `sys_locale` reads the same.
fn clock_of(tag: &str) -> Clock {
    let tag = tag.split(['.', '@']).next().unwrap_or_default();
    let mut parts = tag.split(['-', '_']).filter(|part| !part.is_empty());
    let language = parts.next().unwrap_or_default().to_ascii_lowercase();
    let region = parts
        .find(|part| {
            (part.len() == 2 && part.chars().all(|c| c.is_ascii_alphabetic()))
                || (part.len() == 3 && part.chars().all(|c| c.is_ascii_digit()))
        })
        .map(str::to_ascii_uppercase);
    match language.as_str() {
        "ko" => Clock::Korean12,
        "en" if region.is_some_and(|region| ENGLISH_GB_REGIONS.contains(&region.as_str())) => {
            Clock::Hour24
        }
        "en" => Clock::English12,
        language if UI_LANGUAGES.contains(&language) => Clock::Hour24,
        _ => Clock::English12,
    }
}

/// Shared local clock for `workPlanPresentation.ts` and `formatActivityTime`.
pub(in crate::ui::chat::activity) fn clock_time(value: &str, seconds: bool) -> String {
    let Ok(at) = chrono::DateTime::parse_from_rfc3339(value) else {
        return value.to_string();
    };
    let at = at.with_timezone(&chrono::Local);
    let clock = clock_of(&sys_locale::get_locale().unwrap_or_default());
    let format = match (&clock, seconds) {
        (Clock::Korean12, true) => "%p %I:%M:%S",
        (Clock::Korean12, false) => "%p %I:%M",
        (Clock::English12, true) => "%I:%M:%S %p",
        (Clock::English12, false) => "%I:%M %p",
        (Clock::Hour24, true) => "%H:%M:%S",
        (Clock::Hour24, false) => "%H:%M",
    };
    let text = at.format(format).to_string();
    if clock == Clock::Korean12 {
        text.replace("AM", "오전").replace("PM", "오후")
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::{Clock, clock_of};

    // test-category: pure-logic
    #[test]
    fn the_os_locale_resolves_to_the_clock_intl_uses() {
        for (tag, clock) in [
            ("ko-KR", Clock::Korean12),
            ("ko_KR.UTF-8", Clock::Korean12),
            ("en-US", Clock::English12),
            ("en", Clock::English12),
            ("en_GB", Clock::Hour24),
            ("en-KR", Clock::English12),
            ("en-PH", Clock::English12),
            ("en-AU", Clock::Hour24),
            ("en-CA", Clock::Hour24),
            ("en-DE", Clock::Hour24),
            ("de-DE", Clock::Hour24),
            ("ja-JP", Clock::Hour24),
            ("zh-Hans-CN", Clock::Hour24),
            ("af-ZA", Clock::English12),
            ("", Clock::English12),
        ] {
            assert_eq!(clock_of(tag), clock, "{tag}");
        }
    }
}
