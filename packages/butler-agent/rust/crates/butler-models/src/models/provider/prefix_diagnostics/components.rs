//! Reuse unchanged serialized components, including their exact field order.
use std::sync::Arc;

use butler_turn::btcc::ModelRoundError;
use serde_json::Value;

const CACHE_BYTES: usize = 32 * 1024 * 1024;
const CACHE_ITEMS: usize = 4096;

pub(in crate::models::provider) struct Component {
    source: Option<Value>,
    pub(in crate::models::provider) encoded: String,
    pub(in crate::models::provider) hash: Option<String>,
    bytes: usize,
}

#[derive(Default)]
pub(in crate::models::provider) struct Cache {
    items: Vec<Option<Arc<Component>>>,
    bytes: usize,
}

impl Cache {
    pub(in crate::models::provider) fn array_json(
        &mut self,
        items: &[Value],
    ) -> Result<String, ModelRoundError> {
        let mut output = String::from("[");
        for (index, value) in items.iter().enumerate() {
            if index > 0 {
                output.push(',');
            }
            output.push_str(&self.component(index, value, false)?.encoded);
        }
        output.push(']');
        Ok(output)
    }

    pub(in crate::models::provider) fn component(
        &mut self,
        index: usize,
        value: &Value,
        include_hash: bool,
    ) -> Result<Arc<Component>, ModelRoundError> {
        if let Some(Some(item)) = self.items.get(index)
            && item
                .source
                .as_ref()
                .is_some_and(|old| ordered_eq(old, value))
        {
            return Ok(item.clone());
        }
        let encoded = butler_core::json::stringify(value).map_err(|_| {
            ModelRoundError::StablePrefix("prefix_diagnostic_serialization_failed".into())
        })?;
        let bytes = source_bytes(value) + encoded.capacity() + 64;
        let retained = bytes <= CACHE_BYTES && index < CACHE_ITEMS;
        let item = Arc::new(Component {
            source: retained.then(|| value.clone()),
            hash: include_hash.then(|| super::hash(&encoded)),
            encoded,
            bytes,
        });
        if retained {
            if let Some(Some(old)) = self.items.get_mut(index) {
                self.bytes -= old.bytes;
                self.items[index] = None;
            }
            if self.bytes + bytes > CACHE_BYTES {
                self.items.clear();
                self.bytes = 0;
            }
            self.items
                .resize_with(self.items.len().max(index + 1), || None);
            self.items[index] = Some(item.clone());
            self.bytes += bytes;
        }
        Ok(item)
    }
}

// Value/Map equality ignores object insertion order. The wire codec preserves
// named-key order, so use ordered equality recursively before reusing bytes.
fn ordered_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .zip(b)
                    .all(|((ak, av), (bk, bv))| ak == bk && ordered_eq(av, bv))
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| ordered_eq(a, b))
        }
        _ => a == b,
    }
}

// Account for source strings, keys and every Value node as well as encoded
// bytes. The item limit separately bounds vector/Arc and map entry overhead.
fn source_bytes(value: &Value) -> usize {
    std::mem::size_of::<Value>()
        + match value {
            Value::String(text) => text.len(),
            Value::Array(items) => items.iter().map(source_bytes).sum(),
            Value::Object(items) => items
                .iter()
                .map(|(key, value)| key.len() + std::mem::size_of::<String>() + source_bytes(value))
                .sum(),
            _ => 0,
        }
}
