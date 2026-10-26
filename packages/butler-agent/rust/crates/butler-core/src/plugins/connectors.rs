//! Generic connected-source contracts; content is data, never policy.
use crate::plugins::{PluginError, PluginFuture};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
/// An account input declared by its plugin.
pub struct Field {
    /// Stable machine-readable input key.
    pub key: String,
    /// Short display label.
    pub label: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
/// Declared non-secret and secret account inputs.
pub struct AccountSchema {
    #[serde(default)]
    /// Credential inputs stored only through SecretStore.
    pub secrets: Vec<Field>,
    #[serde(default)]
    /// Non-secret account settings.
    pub fields: Vec<Field>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
/// The declared event transport. `connector://events` returns pending `events`
/// and an opaque string `cursor`. Reads never consume events. After atomically
/// storing the rows and cursor, the host reads `connector://events?after=...`
/// (URL-encoded cursor) to acknowledge through that batch; the reply is `{ok:true}`.
/// Acknowledgement is idempotent. Servers durably retain unacknowledged events
/// across restarts and return them again on the next read. An acknowledgement
/// must never discard events newer than its cursor. Notifications wake reads;
/// neither endpoint polls. `BUTLER_CONNECTOR_CALL_TIMEOUT_MS` is the host's
/// deadline; servers end upstream operations at least 1,000 ms before it.
pub struct Events {
    /// Plugin-relative stdio MCP server id.
    pub server: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
/// Read-only full-content lookup.
pub struct Context {
    /// Plugin-relative server/tool reference.
    pub tool: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
/// The resource and argument for destination validation.
pub struct Destinations {
    /// MCP resource URI reporting destination roles.
    pub resource: String,
    /// Tool argument containing the destination id.
    pub argument: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
/// A declared connector operation.
pub struct Action {
    /// Plugin-relative server/tool reference.
    pub tool: String,
    #[serde(default)]
    /// Whether a model-written rule may invoke this operation.
    pub organize: bool,
    #[serde(default)]
    /// Whether the destination policy applies.
    pub destination: bool,
    #[serde(default)]
    /// Relocates the item, invalidating its previous address. Destination
    /// actions always relocate; this also covers actions without a destination.
    pub relocates: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
/// A generic account-bound plugin event component.
pub struct Connector {
    /// Stable identity within its owning scope.
    pub id: String,
    /// Short display label.
    pub label: String,
    #[serde(default)]
    /// Account input schema.
    pub account: AccountSchema,
    /// Notification-based event source.
    pub events: Events,
    /// Declared read-only context lookup.
    pub context: Context,
    /// Optional destination discovery contract.
    pub destinations: Option<Destinations>,
    #[serde(default)]
    /// Declared operations available to this connector.
    pub actions: Vec<Action>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
/// Delivery scheduling for pending account events.
pub struct Handling {
    /// Immediate or pending-only batch delivery.
    pub mode: String,
    #[serde(default = "interval")]
    /// Batch delay in minutes; positive fractional values are supported.
    pub interval_minutes: f64,
}
fn interval() -> f64 {
    10.0
}
impl Default for Handling {
    fn default() -> Self {
        Self {
            mode: "immediate".into(),
            interval_minutes: interval(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
/// A persisted account with no credential values.
pub struct Account {
    /// Stable identity within its owning scope.
    pub id: String,
    /// Owning plugin id.
    pub plugin: String,
    /// Owning connector id.
    pub connector: String,
    /// Non-secret account settings.
    pub fields: BTreeMap<String, String>,
    /// User-selected delivery policy.
    pub handling: Handling,
    /// Whether the user has connected this account.
    pub enabled: bool,
}
/// App-owned persistence, admission and announcements. Implementations never expose secrets.
pub trait ConnectorStore: Send + Sync {
    /// Execute one typed-by-operation App persistence or admission request.
    fn execute(&self, operation: String, input: Value) -> PluginFuture<'_>;
}
/// Shared App persistence and admission boundary.
pub type SharedStore = Arc<dyn ConnectorStore>;
/// Create a public connector failure containing only a stable code.
pub fn failure(code: &'static str) -> PluginError {
    PluginError { status: 400, code }
}

/// Validate compact external data without deciding its significance.
pub fn validate(mut event: Value, connector: &str, account: &str) -> Result<Value, PluginError> {
    let fail = || failure("connector_event_invalid");
    if serde_json::to_vec(&event).map_err(|_| fail())?.len() > 65536 {
        return Err(failure("connector_event_too_large"));
    }
    let object = event.as_object_mut().ok_or_else(fail)?;
    object.retain(|k, _| {
        matches!(
            k.as_str(),
            "id" | "dedupe_key"
                | "thread_id"
                | "received_at"
                | "from"
                | "addressing"
                | "subject"
                | "snippet"
                | "link"
                | "attributes"
                | "signal"
        )
    });
    object.insert("connector".into(), connector.into());
    object.insert("account".into(), account.into());
    for key in ["id", "dedupe_key", "received_at"] {
        if object
            .get(key)
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            return Err(fail());
        }
    }
    if chrono::DateTime::parse_from_rfc3339(field(&event, "received_at").as_str().ok_or_else(fail)?)
        .is_err()
        || !matches!(
            field(&event, "addressing").as_str(),
            Some("direct" | "member" | "broadcast")
        )
        || field(&event, "snippet")
            .as_str()
            .is_none_or(|s| s.chars().count() > 1000)
        || field(field(&event, "from"), "address").as_str().is_none()
        || field(field(&event, "from"), "display").as_str().is_none()
        || ["subject", "thread_id"]
            .iter()
            .any(|k| field(&event, k).as_str().is_none())
    {
        return Err(fail());
    }
    if event.get("link").is_some_and(|v| !v.is_string()) {
        return Err(fail());
    }
    let attrs = field(&event, "attributes").as_object().ok_or_else(fail)?;
    if attrs.len() > 64
        || attrs
            .iter()
            .any(|(k, v)| k.len() > 256 || v.as_str().is_none_or(|s| s.len() > 4096))
    {
        return Err(fail());
    }
    if !field(&event, "signal").is_null()
        && (field(field(&event, "signal"), "type") != "returned"
            || field(field(&event, "signal"), "ref")
                .as_str()
                .is_none_or(str::is_empty))
    {
        return Err(fail());
    }
    Ok(event)
}
/// Apply model-authored AND conditions mechanically without content classification.
pub fn matches(event: &Value, conditions: &[Value]) -> bool {
    conditions.iter().all(|condition| {
        let name = field(condition, "field").as_str().unwrap_or_default();
        let value = if let Some(header) = name.strip_prefix("attributes.") {
            field(event, "attributes")
                .as_object()
                .and_then(|a| a.iter().find(|(k, _)| k.eq_ignore_ascii_case(header)))
                .map(|(_, v)| v)
        } else if let Some(key) = name.strip_prefix("from.") {
            field(event, "from").get(key)
        } else {
            event.get(name)
        };
        let Some(value) = value.and_then(Value::as_str) else {
            return false;
        };
        let value = value.to_lowercase();
        let expected = field(condition, "value")
            .as_str()
            .unwrap_or_default()
            .to_lowercase();
        if expected.trim().is_empty() {
            return false;
        }
        match field(condition, "op").as_str() {
            Some("equals") => value == expected,
            Some("contains") => value.contains(&expected),
            Some("ends_with") => value.ends_with(&expected),
            _ => false,
        }
    })
}

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}
