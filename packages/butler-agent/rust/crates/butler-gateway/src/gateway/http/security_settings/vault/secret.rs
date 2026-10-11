//! A vault item's secrets: one JSON object per item in the OS credential
//! store. Every value is wiped from memory when dropped and never printed.
use butler_platform::secrets::SecretText;
use serde_json::Value;
use zeroize::Zeroizing;

/// Card secrets: the number, the CVC and, for Korean keyed-in payments, the
/// first two digits of the card PIN and the owner's birth date (or business
/// number).
pub(in crate::gateway::http) const CARD_FIELDS: &[&str] = &["number", "cvc", "pin2", "owner_id"];
/// Traveler secrets.
pub(in crate::gateway::http) const TRAVELER_FIELDS: &[&str] =
    &["birth_date", "passport_number", "rrn"];

#[derive(Default)]
pub(in crate::gateway::http) struct VaultSecret(Vec<(&'static str, Zeroizing<String>)>);

impl VaultSecret {
    pub(in crate::gateway::http) fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.as_str())
    }

    /// Sets a field; an empty value removes it.
    pub(in crate::gateway::http) fn set(&mut self, name: &'static str, value: Zeroizing<String>) {
        self.0.retain(|(key, _)| *key != name);
        if !value.is_empty() {
            self.0.push((name, value));
        }
    }

    /// The names of the stored fields (never their values).
    pub(in crate::gateway::http) fn names(&self) -> Vec<String> {
        self.0.iter().map(|(key, _)| (*key).to_owned()).collect()
    }

    pub(in crate::gateway::http) fn to_text(&self) -> SecretText {
        let mut text = Zeroizing::new(String::from("{"));
        for (index, (key, value)) in self.0.iter().enumerate() {
            if index > 0 {
                text.push(',');
            }
            text.push('"');
            text.push_str(key);
            text.push_str("\":");
            let quoted = Zeroizing::new(serde_json::to_string(value.as_str()).unwrap_or_default());
            text.push_str(&quoted);
        }
        text.push('}');
        SecretText::new(std::mem::take(&mut *text))
    }

    /// Reads the fields this kind keeps; anything else is dropped.
    pub(in crate::gateway::http) fn parse(text: &SecretText, fields: &[&'static str]) -> Self {
        let mut secret = Self::default();
        let Ok(mut map) = serde_json::from_str::<serde_json::Map<String, Value>>(text.expose())
        else {
            return secret;
        };
        for name in fields {
            if let Some(Value::String(value)) = map.get_mut(*name) {
                secret.set(name, Zeroizing::new(std::mem::take(value)));
            }
        }
        secret
    }
}

/// Takes a string field out of a request body into wiped memory.
pub(in crate::gateway::http) fn take(body: &mut Value, name: &str) -> Option<Zeroizing<String>> {
    match body.get_mut(name) {
        Some(Value::String(value)) => Some(Zeroizing::new(std::mem::take(value))),
        _ => None,
    }
}

/// The digits of `raw` (spaces and dashes dropped); `None` if anything else is in it.
pub(in crate::gateway::http) fn digits(raw: &str) -> Option<Zeroizing<String>> {
    let mut out = Zeroizing::new(String::with_capacity(raw.len()));
    for character in raw.chars() {
        if character.is_ascii_digit() {
            out.push(character);
        } else if !matches!(character, ' ' | '-') {
            return None;
        }
    }
    Some(out)
}

pub(in crate::gateway::http) fn luhn(number: &str) -> bool {
    let mut sum = 0;
    for (index, digit) in number.bytes().rev().enumerate() {
        let mut value = u32::from(digit - b'0');
        if index % 2 == 1 {
            value *= 2;
            if value > 9 {
                value -= 9;
            }
        }
        sum += value;
    }
    sum % 10 == 0
}

/// The card network by its leading digits (`local` for Korean domestic-only cards).
pub(in crate::gateway::http) fn brand(number: &str) -> &'static str {
    let prefix = |len: usize| {
        number
            .get(..len)
            .and_then(|p| p.parse::<u32>().ok())
            .unwrap_or(0)
    };
    match (prefix(1), prefix(2), prefix(3), prefix(4)) {
        (4, ..) => "visa",
        (_, 51..=55, ..) | (.., 2221..=2720) => "mastercard",
        (_, 34 | 37, ..) => "amex",
        (.., 3528..=3589) => "jcb",
        (_, 62, ..) => "unionpay",
        (_, 65, ..) | (_, _, 644..=649, _) | (.., 6011) => "discover",
        (_, 36 | 38 | 39, ..) | (_, _, 300..=305, _) => "diners",
        (9, ..) => "local",
        _ => "unknown",
    }
}
