//! Source-sized provider preview over borrowed encoded JSON.

use std::borrow::Cow;

use serde_json::Value;

use crate::{
    btcc::BtccError,
    json::{bound_raw_string, raw_string_contains_any, visit_raw_array, visit_raw_object},
};

const CONTROL_FACTS: &[&str] = &[
    "status",
    "state",
    "outcome",
    "authority_pending",
    "approval_status",
    "request_status",
    "execution_status",
    "executed",
    "not_executed",
    "pending",
    "queued",
    "exit_code",
    "timed_out",
    "signal",
    "error_code",
    "current_stage",
    "action_key",
    "action_status",
    "next_action",
];

pub(super) fn fit(
    projected: &str,
    name: &str,
    exact_read: Option<&Value>,
    max_bytes: usize,
) -> Result<String, BtccError> {
    if projected.len() <= max_bytes {
        return Ok(projected.into());
    }
    let structural = structural(projected, name, projected.len(), exact_read)?;
    for (chars, items) in [(4_800, 16), (2_400, 8), (1_200, 4), (480, 2), (160, 1)] {
        let Some(mut candidate) = Node::bounded(projected, chars, items, 0)? else {
            continue;
        };
        candidate.merge(&structural, projected)?;
        let preview = candidate.encode()?;
        if preview.len() <= max_bytes {
            return Ok(preview);
        }
    }
    let mut fallback = structural;
    fallback.restore_errors(projected)?;
    fallback.encode()
}

pub(super) fn metadata(original_bytes: usize, exact_read: Option<&Value>) -> Value {
    let mut metadata = serde_json::json!({
        "truncated":true,"completeness":"partial","original_provider_bytes":original_bytes
    });
    if let Some(read) = exact_read {
        metadata["exact_read"] = read.clone();
    }
    metadata
}

pub(super) fn signals_partial(raw: &str) -> bool {
    let raw = raw.trim();
    if raw.starts_with('"') {
        return raw_string_contains_any(
            raw,
            &["[middle omitted]", "[content omitted", "[preview cut"],
        );
    }
    if raw.starts_with('{') {
        let mut found = false;
        let _ = visit_raw_object(raw, |key, value| {
            let name = serde_json::from_str::<String>(key).ok();
            found |= name.as_deref().is_some_and(|key| {
                [
                    "preview_content_truncated",
                    "truncated_by_lines",
                    "truncated_by_tokens",
                    "content_has_more",
                    "markdown_truncated",
                ]
                .contains(&key)
                    && value == "true"
            }) || signals_partial(value);
            Ok(())
        });
        return found;
    }
    if raw.starts_with('[') {
        let mut found = false;
        let _ = visit_raw_array(raw, |item| {
            found |= signals_partial(item);
            Ok(())
        });
        return found;
    }
    false
}

fn structural<'a>(
    projected: &'a str,
    name: &str,
    original_bytes: usize,
    exact_read: Option<&Value>,
) -> Result<Node<'a>, BtccError> {
    let mut root = Vec::new();
    if let Some(ok) = field(projected, "ok")?
        && bool_raw(ok)
    {
        set(&mut root, "ok", Node::Raw(Cow::Borrowed(ok)));
    }
    let output = field(projected, "output")?.filter(|raw| raw.trim().starts_with('{'));
    if let Some(error) =
        field(projected, "error")?.or_else(|| output.and_then(|o| field(o, "error").ok().flatten()))
        && let Some(identity) = error_node(error)?
    {
        set(&mut root, "error", identity);
    }
    if let Some(output) = output {
        let mut public = Vec::new();
        set(&mut public, "tool_name", Node::quoted(name)?);
        if let Some(ok) = field(output, "ok")?
            && bool_raw(ok)
        {
            set(&mut public, "ok", Node::Raw(Cow::Borrowed(ok)));
        }
        if let Some(error) = field(output, "error")?
            .map(error_node)
            .transpose()?
            .flatten()
        {
            set(&mut public, "error", error);
        }
        for key in CONTROL_FACTS {
            if let Some(raw) = field(output, key)?
                && primitive_raw(raw)
            {
                set(&mut public, key, Node::Raw(Cow::Borrowed(raw)));
            }
        }
        if let Some(artifact) = field(output, "butler_tool_artifact")? {
            set(
                &mut public,
                "butler_tool_artifact",
                Node::Raw(Cow::Borrowed(artifact)),
            );
            let mut presentation = match field(output, "output_presentation")? {
                Some(raw) if raw.trim().starts_with('{') => Node::unbounded_object(raw)?,
                _ => Node::Object(Vec::new()),
            };
            if let Node::Object(entries) = &mut presentation {
                set(entries, "truncated", Node::Raw(Cow::Borrowed("true")));
            }
            set(&mut public, "output_presentation", presentation);
        }
        if let Some(work) = field(output, "work")?.filter(|raw| raw.trim().starts_with('{')) {
            set(&mut public, "work", Node::Raw(Cow::Borrowed(work)));
        }
        set(&mut root, "output", Node::Object(public));
    }
    let mut preview = metadata(original_bytes, exact_read);
    if let Some(path) = output
        .and_then(|o| field(o, "butler_tool_artifact").ok().flatten())
        .and_then(|a| field(a, "path").ok().flatten())
        .and_then(|p| serde_json::from_str::<String>(p).ok())
    {
        preview["artifact_read"] = serde_json::json!({"capability":"read_tool_output_artifact",
            "arguments":{"path":path,"offset_chars":0,"stream":"both"}});
    }
    set(
        &mut root,
        "model_preview",
        Node::Raw(Cow::Owned(encode_value(&preview)?)),
    );
    Ok(Node::Object(root))
}

fn error_node(raw: &str) -> Result<Option<Node<'_>>, BtccError> {
    if raw.trim().starts_with('"') {
        return Ok(Some(Node::Raw(Cow::Owned(
            bound_raw_string(raw.trim(), 480).map_err(json_error)?,
        ))));
    }
    if !raw.trim().starts_with('{') {
        return Ok(None);
    }
    let mut identity = Vec::new();
    for key in [
        "code",
        "name",
        "status",
        "current_stage",
        "requested_action",
        "unmet_guard",
        "next_action",
    ] {
        if let Some(value) = field(raw, key)? {
            set(&mut identity, key, Node::Raw(Cow::Borrowed(value)));
        }
    }
    if let Some(message) = field(raw, "message")?.filter(|raw| raw.trim().starts_with('"')) {
        set(
            &mut identity,
            "message",
            Node::Raw(Cow::Owned(
                bound_raw_string(message.trim(), 480).map_err(json_error)?,
            )),
        );
    }
    Ok(Some(Node::Object(identity)))
}

#[derive(Clone)]
struct Key {
    encoded: String,
    decoded: Option<String>,
}
impl Key {
    fn source(raw: &str) -> Self {
        Self {
            encoded: raw.into(),
            decoded: serde_json::from_str(raw).ok(),
        }
    }
    fn known(name: &str) -> Self {
        Self {
            encoded: serde_json::Value::from(name).to_string(),
            decoded: Some(name.into()),
        }
    }
    fn is(&self, name: &str) -> bool {
        self.decoded.as_deref() == Some(name)
    }
}
#[derive(Clone)]
enum Node<'a> {
    Raw(Cow<'a, str>),
    Object(Vec<(Key, Node<'a>)>),
    Array(Vec<Node<'a>>),
}
impl<'a> Node<'a> {
    fn quoted(text: &str) -> Result<Self, BtccError> {
        Ok(Self::Raw(Cow::Owned(encode_value(&Value::String(
            text.into(),
        ))?)))
    }
    fn unbounded_object(raw: &'a str) -> Result<Self, BtccError> {
        let mut fields = Vec::new();
        visit_raw_object(raw, |key, value| {
            fields.push((Key::source(key), Self::Raw(Cow::Borrowed(value))));
            Ok(())
        })
        .map_err(json_error)?;
        Ok(Self::Object(fields))
    }
    fn bounded(
        raw: &'a str,
        chars: usize,
        items: usize,
        depth: usize,
    ) -> Result<Option<Self>, BtccError> {
        let raw = raw.trim();
        if raw.starts_with('"') {
            return Ok(Some(Self::Raw(Cow::Owned(
                bound_raw_string(raw, chars).map_err(json_error)?,
            ))));
        }
        if depth >= 5 {
            return Ok(None);
        }
        if raw.starts_with('{') {
            let mut fields = Vec::new();
            visit_raw_object(raw, |key, value| {
                if let Some(node) = Self::bounded(value, chars, items, depth + 1)
                    .map_err(|e| crate::json::JsonError::new(e.to_string()))?
                {
                    fields.push((Key::source(key), node));
                }
                Ok(())
            })
            .map_err(json_error)?;
            return Ok(Some(Self::Object(fields)));
        }
        if raw.starts_with('[') {
            let mut values = Vec::new();
            visit_raw_array(raw, |value| {
                if values.len() < items
                    && let Some(node) = Self::bounded(value, chars, items, depth + 1)
                        .map_err(|e| crate::json::JsonError::new(e.to_string()))?
                {
                    values.push(node);
                }
                Ok(())
            })
            .map_err(json_error)?;
            return Ok(Some(Self::Array(values)));
        }
        Ok(Some(Self::Raw(Cow::Borrowed(raw))))
    }
    fn merge(&mut self, structural: &Self, projected: &'a str) -> Result<(), BtccError> {
        let Self::Object(entries) = self else {
            return Ok(());
        };
        let Self::Object(facts) = structural else {
            return Ok(());
        };
        for (key, value) in facts {
            if key.is("output")
                && let (Some((_, Self::Object(bounded))), Self::Object(structural_output)) = (
                    entries.iter_mut().find(|(entry, _)| entry.is("output")),
                    value,
                )
            {
                for (name, field) in structural_output {
                    set_key(bounded, name.clone(), field.clone());
                }
                continue;
            }
            set_key(entries, key.clone(), value.clone());
        }
        self.restore_errors(projected)
    }
    fn restore_errors(&mut self, projected: &'a str) -> Result<(), BtccError> {
        let Self::Object(entries) = self else {
            return Ok(());
        };
        let output = field(projected, "output")?.filter(|raw| raw.trim().starts_with('{'));
        if let Some(error) = field(projected, "error")?
            .or_else(|| output.and_then(|o| field(o, "error").ok().flatten()))
            .map(error_node)
            .transpose()?
            .flatten()
        {
            set(entries, "error", error);
        }
        if let Some(error) = output
            .and_then(|o| field(o, "error").ok().flatten())
            .map(error_node)
            .transpose()?
            .flatten()
            && let Some((_, Self::Object(output))) =
                entries.iter_mut().find(|(key, _)| key.is("output"))
        {
            set(output, "error", error);
        }
        Ok(())
    }
    fn encode(&self) -> Result<String, BtccError> {
        let mut output = String::new();
        self.append(&mut output);
        Ok(output)
    }
    fn append(&self, out: &mut String) {
        match self {
            Self::Raw(raw) => out.push_str(raw),
            Self::Object(fields) => {
                out.push('{');
                for (index, (key, value)) in fields.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    out.push_str(&key.encoded);
                    out.push(':');
                    value.append(out);
                }
                out.push('}');
            }
            Self::Array(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    item.append(out);
                }
                out.push(']');
            }
        }
    }
}
fn set<'a>(entries: &mut Vec<(Key, Node<'a>)>, name: &str, value: Node<'a>) {
    set_key(entries, Key::known(name), value);
}
fn set_key<'a>(entries: &mut Vec<(Key, Node<'a>)>, key: Key, value: Node<'a>) {
    if let Some((_, previous)) = entries
        .iter_mut()
        .find(|(entry, _)| entry.decoded == key.decoded && key.decoded.is_some())
    {
        *previous = value;
    } else {
        entries.push((key, value));
    }
}
fn field<'a>(raw: &'a str, name: &str) -> Result<Option<&'a str>, BtccError> {
    if !raw.trim().starts_with('{') {
        return Ok(None);
    }
    let mut selected = None;
    visit_raw_object(raw, |key, value| {
        if serde_json::from_str::<String>(key).ok().as_deref() == Some(name) {
            selected = Some(value);
        }
        Ok(())
    })
    .map_err(json_error)?;
    Ok(selected)
}
fn bool_raw(raw: &str) -> bool {
    raw == "true" || raw == "false"
}
fn primitive_raw(raw: &str) -> bool {
    !raw.starts_with('{') && !raw.starts_with('[')
}
fn encode_value(value: &Value) -> Result<String, BtccError> {
    crate::json::stringify(value).map_err(json_error)
}
#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn json_error(error: crate::json::JsonError) -> BtccError {
    BtccError::new(
        "guided_tool_provider_serialization_failed",
        error.to_string(),
    )
}
