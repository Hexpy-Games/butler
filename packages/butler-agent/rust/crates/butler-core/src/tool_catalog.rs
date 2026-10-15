//! Bundled model-facing tool contracts, resolved before surface selection.

use serde::de::Error;
use serde_json::Value;

const SOURCE: &str = include_str!("../../butler-runtime/src/capabilities/catalog/catalog.json");
const SCHEMAS: &[(&str, &str)] = &[(
    "answer-blocks.schema.json",
    include_str!("../../butler-runtime/src/capabilities/catalog/answer-blocks.schema.json"),
)];

/// Parse the bundled catalog and inline every bundled external schema reference.
/// External references must stand alone; unknown or cyclic references fail loading.
/// Local references remain relative to their inlined schema root.
pub fn load() -> Result<Value, serde_json::Error> {
    let mut catalog = serde_json::from_str(SOURCE)?;
    expand(&mut catalog, &mut Vec::new())?;
    Ok(catalog)
}

fn expand(value: &mut Value, stack: &mut Vec<String>) -> Result<(), serde_json::Error> {
    if let Some(reference) = value.get("$ref").and_then(Value::as_str)
        && !reference.starts_with('#')
    {
        let reference = reference.to_owned();
        if value.as_object().is_none_or(|fields| fields.len() != 1) {
            return Err(serde_json::Error::custom(format!(
                "bundled tool schema reference has sibling fields: {reference}"
            )));
        }
        if stack.contains(&reference) {
            return Err(serde_json::Error::custom(format!(
                "cyclic tool schema reference: {reference}"
            )));
        }
        let source = SCHEMAS
            .iter()
            .find_map(|(name, source)| (*name == reference).then_some(*source))
            .ok_or_else(|| {
                serde_json::Error::custom(format!("unknown tool schema reference: {reference}"))
            })?;
        let mut schema = serde_json::from_str(source)?;
        stack.push(reference);
        expand(&mut schema, stack)?;
        stack.pop();
        *value = schema;
        return Ok(());
    }
    match value {
        Value::Object(fields) => {
            for field in fields.values_mut() {
                expand(field, stack)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                expand(item, stack)?;
            }
        }
        _ => {}
    }
    Ok(())
}
