//! Failure injection as declared transforms of real recordings
//! (PROVIDER_CONFIG.md §4.3). No transform invents a success response.
//!
//! | Transform | Effect on the recorded response |
//! |-----------|---------------------------------|
//! | `ErrorFromLibrary(name)` | Serve the real error exchange recorded in `cassettes/_errors/<name>` (status, headers, body) instead. |
//! | `TruncateAfter(k)` | Send the first `k` chunks, then end the body cleanly (EOF without the completion event). |
//! | `ResetAfter(k)` | Send `k` chunks, then abort the connection (body error). |
//! | `StallAfter(k)` | Send `k` chunks, then send nothing until the client gives up. |
//! | `MutateToolArgs(op)` | Rewrite the recorded function-call `arguments` (as the product reads them from `response.output_item.done`) or tool `name`: truncate, wrong types, unknown tool, substring replace or verbatim edits. Streamed argument deltas (UI-only) are left as recorded. |

use serde_json::Value;

#[derive(Clone, Debug)]
pub enum Transform {
    ErrorFromLibrary(String),
    TruncateAfter(usize),
    ResetAfter(usize),
    StallAfter(usize),
    MutateToolArgs(ArgsMutation),
}

#[derive(Clone, Debug)]
pub enum ArgsMutation {
    /// Apply `mutation` only to calls of the tool named `tool`.
    OnlyTool {
        tool: String,
        mutation: Box<ArgsMutation>,
    },
    /// Cut the arguments JSON in half (unparseable).
    Truncate,
    /// Replace every string value in the arguments object by a number.
    WrongTypes,
    /// Rename the called tool to one that does not exist.
    UnknownTool,
    /// Replace a substring inside the arguments JSON text (e.g. a recorded
    /// relative path by an escaping one). `to` is JSON-escaped.
    Replace { from: String, to: String },
    /// Replace substrings of the arguments JSON text verbatim, in order
    /// (e.g. swap one requested file and widen a recorded read limit).
    Edits(Vec<(String, String)>),
}

/// Which requests a fault applies to.
#[derive(Clone, Debug)]
pub struct Fault {
    /// Recorded exchange index the fault targets (`None`: any match).
    pub exchange: Option<usize>,
    /// Alternative target: a request whose user request contains `.0` and
    /// whose tool round has `.1` items. Works in record mode too.
    pub request: Option<(String, Option<usize>)>,
    /// Number of matching hits still to transform (`None`: every hit).
    pub remaining: Option<u32>,
    pub transform: Transform,
}

impl Fault {
    pub fn once(exchange: usize, transform: Transform) -> Self {
        Self {
            exchange: Some(exchange),
            request: None,
            remaining: Some(1),
            transform,
        }
    }

    pub fn times(exchange: usize, times: u32, transform: Transform) -> Self {
        Self {
            exchange: Some(exchange),
            request: None,
            remaining: Some(times),
            transform,
        }
    }

    /// Targets a request by its user text and tool-round length. In record
    /// mode only `MutateToolArgs` applies: the live reply is rewritten on its
    /// way to the product (the cassette keeps the original), so the model's
    /// real follow-up to the resulting tool error is what gets recorded.
    pub fn on_request(text: &str, round_len: usize, transform: Transform) -> Self {
        Self {
            exchange: None,
            request: Some((text.to_owned(), Some(round_len))),
            remaining: Some(1),
            transform,
        }
    }

    /// Every reply to requests whose user request contains `text` (all tool
    /// rounds), e.g. to rewrite every call of one tool.
    pub fn every_reply(text: &str, transform: Transform) -> Self {
        Self {
            exchange: None,
            request: Some((text.to_owned(), None)),
            remaining: None,
            transform,
        }
    }

    /// The first call of one tool in replies to requests whose user request
    /// contains `text` (use with `ArgsMutation::OnlyTool`).
    pub fn first_call(text: &str, transform: Transform) -> Self {
        Self {
            exchange: None,
            request: Some((text.to_owned(), None)),
            remaining: Some(1),
            transform,
        }
    }

    pub fn matches(&self, index: Option<usize>, key: &super::cassette::MatchKey) -> bool {
        self.remaining.is_none_or(|remaining| remaining > 0)
            && self.exchange.is_none_or(|target| Some(target) == index)
            && self.request.as_ref().is_none_or(|(text, round_len)| {
                key.user_request.contains(text.as_str())
                    && round_len.is_none_or(|round_len| key.round.len() == round_len)
            })
    }

    pub fn always(exchange: usize, transform: Transform) -> Self {
        Self {
            exchange: Some(exchange),
            request: None,
            remaining: None,
            transform,
        }
    }
}

/// Applies an arguments mutation to one SSE chunk (`data: {json}` lines).
pub fn mutate_chunk(text: &str, mutation: &ArgsMutation) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let (content, newline) = match line.strip_suffix('\n') {
            Some(content) => (content, "\n"),
            None => (line, ""),
        };
        if let Some(data) = content.strip_prefix("data: ")
            && let Ok(mut value) = serde_json::from_str::<Value>(data)
        {
            mutate_value(&mut value, mutation);
            out.push_str("data: ");
            out.push_str(&value.to_string());
            out.push_str(newline);
        } else {
            out.push_str(line);
        }
    }
    out
}

fn mutate_value(value: &mut Value, mutation: &ArgsMutation) {
    if let ArgsMutation::OnlyTool { tool, mutation } = mutation {
        return mutate_tool(value, tool, mutation);
    }
    match value {
        Value::Object(object) => {
            let is_call = object
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind == "function_call" || kind == "function")
                || object.contains_key("call_id");
            for (key, child) in object.iter_mut() {
                match (key.as_str(), mutation) {
                    ("arguments", mutation)
                        if child.is_string() && !matches!(mutation, ArgsMutation::UnknownTool) =>
                    {
                        if let Some(text) = child.as_str() {
                            *child = Value::String(mutate_arguments(text, mutation));
                        }
                    }
                    ("name", ArgsMutation::UnknownTool) if is_call && child.is_string() => {
                        *child = Value::String("e2e_nonexistent_tool".into());
                    }
                    _ => mutate_value(child, mutation),
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                mutate_value(item, mutation);
            }
        }
        _ => {}
    }
}

fn mutate_tool(value: &mut Value, tool: &str, mutation: &ArgsMutation) {
    match value {
        Value::Object(object) => {
            if object.get("name").and_then(Value::as_str) == Some(tool)
                && object.contains_key("arguments")
            {
                let mut item = Value::Object(object.clone());
                mutate_value(&mut item, mutation);
                *value = item;
                return;
            }
            for child in object.values_mut() {
                mutate_tool(child, tool, mutation);
            }
        }
        Value::Array(items) => {
            for item in items {
                mutate_tool(item, tool, mutation);
            }
        }
        _ => {}
    }
}

fn mutate_arguments(text: &str, mutation: &ArgsMutation) -> String {
    match mutation {
        ArgsMutation::Truncate => {
            let cut = text
                .char_indices()
                .nth(text.chars().count() / 2)
                .map_or(text.len(), |(index, _)| index);
            text[..cut].to_owned()
        }
        ArgsMutation::WrongTypes => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(mut object)) => {
                for value in object.values_mut() {
                    if value.is_string() {
                        *value = Value::from(12_345);
                    }
                }
                Value::Object(object).to_string()
            }
            _ => text.to_owned(),
        },
        ArgsMutation::Replace { from, to } => {
            let quoted = Value::String(to.clone()).to_string();
            text.replace(from.as_str(), &quoted[1..quoted.len() - 1])
        }
        ArgsMutation::Edits(edits) => edits
            .iter()
            .fold(text.to_owned(), |text, (from, to)| text.replace(from, to)),
        ArgsMutation::UnknownTool | ArgsMutation::OnlyTool { .. } => text.to_owned(),
    }
}
