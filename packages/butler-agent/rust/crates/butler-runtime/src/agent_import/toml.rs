//! Codex `config.toml`: only the `mcp_servers` table is read.
use super::FormatError;
use serde_json::{Map, Value};
use toml_edit::{Item, Table, TableLike};

/// The `mcp_servers` table as JSON-shaped values.
pub(super) fn mcp_servers(text: &str) -> Result<Value, FormatError> {
    let document = toml_edit::Document::parse(text).map_err(|_| FormatError)?;
    Ok(document
        .as_table()
        .get("mcp_servers")
        .map_or(Value::Null, item))
}

fn item(item: &Item) -> Value {
    match item {
        Item::None => Value::Null,
        Item::Value(value) => self::value(value),
        Item::Table(table) => object(table),
        Item::ArrayOfTables(tables) => Value::Array(tables.iter().map(object).collect()),
    }
}

fn object(table: &Table) -> Value {
    like(table)
}

fn like(table: &dyn TableLike) -> Value {
    Value::Object(
        table
            .iter()
            .map(|(key, entry)| (key.to_owned(), item(entry)))
            .collect::<Map<_, _>>(),
    )
}

fn value(value: &toml_edit::Value) -> Value {
    use toml_edit::Value as V;
    match value {
        V::String(text) => Value::String(text.value().clone()),
        V::Integer(number) => Value::from(*number.value()),
        V::Float(number) => {
            serde_json::Number::from_f64(*number.value()).map_or(Value::Null, Value::Number)
        }
        V::Boolean(flag) => Value::Bool(*flag.value()),
        V::Datetime(date) => Value::String(date.value().to_string()),
        V::Array(items) => Value::Array(items.iter().map(self::value).collect()),
        V::InlineTable(table) => like(table),
    }
}
