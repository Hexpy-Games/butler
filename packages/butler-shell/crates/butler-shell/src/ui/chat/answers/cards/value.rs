//! `answerValueFormat.ts`: one card value (or its `was`) in the UI language.
use butler_ds::ui::context::Lang;

use crate::ui::source::wire::CardValue;

/// Currencies Korean names with their own unit word after the number (`CURRENCY_WORDS`).
const KO_WORDS: [(&str, &str); 3] = [("KRW", "원"), ("JPY", "엔"), ("CNY", "위안")];
/// Currencies without fraction digits.
const WHOLE: [&str; 4] = ["KRW", "JPY", "VND", "CLP"];

/// `1234.5` as "1,234.5": grouped integer part, fraction between `min` and `max` digits.
fn number(amount: f64, min: usize, max: usize) -> String {
    let fixed = format!("{:.*}", max, amount.abs());
    let (whole, fraction) = fixed.split_once('.').unwrap_or((fixed.as_str(), ""));
    let mut fraction = fraction.trim_end_matches('0').to_owned();
    while fraction.len() < min {
        fraction.push('0');
    }
    let mut grouped = String::new();
    for (index, digit) in whole.chars().enumerate() {
        if index > 0 && (whole.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    let negative = amount < 0. && fixed.chars().any(|c| c.is_ascii_digit() && c != '0');
    let sign = if negative { "-" } else { "" };
    if fraction.is_empty() {
        format!("{sign}{grouped}")
    } else {
        format!("{sign}{grouped}.{fraction}")
    }
}

/// The currency's symbol; Korean UIs write CNY with the bare symbol (`narrowSymbol`).
fn symbol(lang: Lang, currency: &str) -> Option<&'static str> {
    Some(match currency {
        "USD" => "$",
        "EUR" => "€",
        "GBP" => "£",
        "INR" => "₹",
        "JPY" => "¥",
        "KRW" => "₩",
        "CNY" if lang == Lang::Ko => "¥",
        "CNY" => "CN¥",
        _ => return None,
    })
}

/// `formatAnswerValue(value, locale, amount)`.
pub(super) fn format_value(value: &CardValue, lang: Lang, amount: f64) -> String {
    let (unit, currency) = match value {
        CardValue::Variant1(v) => (v.unit.as_deref(), None),
        CardValue::Variant2(v) => (None, v.cur.as_deref()),
    };
    let Some(currency) = currency else {
        let plain = number(amount, 0, 3);
        return [Some(plain.as_str()), unit.filter(|u| !u.is_empty())]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
    };
    let code = currency.to_uppercase();
    let digits = if WHOLE.contains(&code.as_str()) { 0 } else { 2 };
    let text = number(amount, digits, digits);
    if lang == Lang::Ko
        && let Some((_, word)) = KO_WORDS.iter().find(|(c, _)| *c == code)
    {
        return format!("{text}{word}");
    }
    match symbol(lang, &code) {
        Some(symbol) => format!("{symbol}{text}"),
        None => format!("{code}\u{a0}{text}"),
    }
}

/// The amount of a value.
pub(super) fn amount(value: &CardValue) -> f64 {
    match value {
        CardValue::Variant1(v) => v.amount,
        CardValue::Variant2(v) => v.amount,
    }
}

/// The earlier amount of a value.
pub(super) fn was(value: &CardValue) -> Option<f64> {
    match value {
        CardValue::Variant1(v) => v.was,
        CardValue::Variant2(v) => v.was,
    }
}

/// The condition line of a value.
pub(super) fn note(value: &CardValue) -> Option<&str> {
    match value {
        CardValue::Variant1(v) => v.note.as_deref(),
        CardValue::Variant2(v) => v.note.as_deref(),
    }
}

/// A value as the scrap's structured field.
pub(super) fn to_json(value: &CardValue) -> serde_json::Value {
    let fields = match value {
        CardValue::Variant1(v) => serde_json::json!({
            "amount": v.amount, "was": v.was, "note": v.note, "unit": v.unit,
        }),
        CardValue::Variant2(v) => serde_json::json!({
            "amount": v.amount, "was": v.was, "note": v.note, "cur": v.cur,
        }),
    };
    match fields {
        serde_json::Value::Object(map) => {
            serde_json::Value::Object(map.into_iter().filter(|(_, v)| !v.is_null()).collect())
        }
        other => other,
    }
}
