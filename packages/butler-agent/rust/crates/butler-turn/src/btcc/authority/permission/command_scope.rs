//! Encode the command's borrowed fields without rebuilding and sorting a JSON object per source.
use super::{AuthorityError, AuthorityResult, canonical, digest};
use butler_core::locale::LocaleCollation;
use serde_json::Value;

pub(in crate::btcc::authority) struct CommandScope {
    keys: [&'static str; 4],
}

#[derive(Clone, Copy)]
enum Field<'a> {
    Text(&'a str),
    Json(&'a Value),
}

impl CommandScope {
    pub(in crate::btcc::authority) fn new(collation: &LocaleCollation) -> Self {
        // These non-index keys have the same initial order as the original map.
        // Preserve the configured locale's stable ordering, including ties.
        let mut keys = ["kind", "command", "cwd", "stateEffect"];
        keys.sort_by(|a, b| collation.compare(a, b));
        Self { keys }
    }

    pub(in crate::btcc::authority) fn key(
        &self,
        input: &Value,
        collation: &LocaleCollation,
    ) -> AuthorityResult<String> {
        self.encode(
            [
                input.get("command").map(Field::Json),
                input.get("cwd").map(Field::Json),
                input.get("state_effect").map(Field::Json),
            ],
            collation,
        )
    }

    pub(super) fn key_borrowed(
        &self,
        command: &str,
        cwd: Option<&str>,
        effect: Option<&Value>,
        collation: &LocaleCollation,
    ) -> AuthorityResult<String> {
        self.encode(
            [
                Some(Field::Text(command)),
                cwd.map(Field::Text),
                effect.map(Field::Json),
            ],
            collation,
        )
    }

    fn encode(
        &self,
        fields: [Option<Field<'_>>; 3],
        collation: &LocaleCollation,
    ) -> AuthorityResult<String> {
        let mut output = String::from("{");
        for key in self.keys {
            let value = match key {
                "command" => fields[0],
                "cwd" => fields[1],
                "stateEffect" => fields[2],
                _ => None,
            };
            if key != "kind" && value.is_none() {
                continue;
            }
            if output.len() > 1 {
                output.push(',');
            }
            output.push('"');
            output.push_str(key);
            output.push_str("\":");
            if key == "kind" {
                output.push_str("\"command\"");
            } else if let Some(value) = value {
                append(value, &mut output, collation)?;
            }
        }
        output.push('}');
        Ok(digest(&output))
    }
}

fn append(
    value: Field<'_>,
    output: &mut String,
    collation: &LocaleCollation,
) -> AuthorityResult<()> {
    let result = match value {
        Field::Text(text) => butler_core::json::write_string(text, output),
        Field::Json(value) if value.is_array() || value.is_object() => {
            // Nested arbitrary documents retain recursive locale sorting.
            output.push_str(&canonical(value, collation)?);
            return Ok(());
        }
        Field::Json(value) => butler_core::json::append_json(value, output),
    };
    result.map_err(|error| {
        AuthorityError::policy(format!("authority_json: {error}")).with_source(error)
    })
}
