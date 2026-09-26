use serde::Deserializer;
use serde::de::{MapAccess, Visitor};
use serde_json::value::RawValue;

use crate::json::JsonError;

/// Borrow the last matching object field, as JSON.parse would. Both keys and
/// values are read as raw tokens so unrelated lone-surrogate text is preserved.
pub(super) fn field<'a>(encoded: &'a str, name: &str) -> Result<Option<&'a str>, JsonError> {
    if !encoded.trim_start().starts_with('{') {
        return Ok(None);
    }
    let mut deserializer = serde_json::Deserializer::from_str(encoded);
    deserializer
        .deserialize_map(FindField(name))
        .map_err(|error| JsonError::new(error.to_string()))
}

struct FindField<'a>(&'a str);

impl<'de> Visitor<'de> for FindField<'_> {
    type Value = Option<&'de str>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a JSON object")
    }

    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
        let mut selected = None;
        while let Some((key, value)) = map.next_entry::<&RawValue, &RawValue>()? {
            // Ordinary keys borrow directly. Escaped keys need a temporary
            // decode; a lone-surrogate key cannot equal a valid Rust str.
            let matches = match serde_json::from_str::<&str>(key.get()) {
                Ok(key) => key == self.0,
                Err(_) => serde_json::from_str::<String>(key.get()).is_ok_and(|key| key == self.0),
            };
            if matches {
                selected = Some(value.get());
            }
        }
        Ok(selected)
    }
}
