//! User configuration for command and HTTP hooks; unsupported scopes are rejected.
use super::HookEvent;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
/// One user-scope configuration file.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HookConfig {
    /// Schema major, currently 1.
    pub version: u32,
    /// File order is execution/decision order.
    pub hooks: Vec<HookDefinition>,
}
/// Exact names or trailing-star tool prefixes.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HookMatcher {
    /// Tool matchers; empty matches every tool.
    pub tools: Vec<String>,
}
/// User-authored command or HTTP endpoint, never an approval grant.
#[derive(Clone, Debug, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HookDefinition {
    /// Unique id within the user file.
    pub id: String,
    /// Optional display name.
    pub name: Option<String>,
    /// Event to receive.
    pub event: HookEvent,
    /// Tool filter, only for tool events.
    #[serde(default, rename = "match")]
    pub matcher: HookMatcher,
    /// command or http.
    #[serde(rename = "type")]
    pub kind: String,
    /// Shell command; mutually exclusive with args.
    pub command: Option<String>,
    /// Executable and literal argv; no shell.
    pub args: Option<Vec<String>>,
    /// http(s) endpoint receiving the envelope as a JSON POST; http hooks only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Literal environment additions.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Timeout in milliseconds (default 30 seconds).
    #[serde(default)]
    pub timeout_ms: u64,
    /// Observe-only background execution.
    #[serde(default, rename = "async")]
    pub asynchronous: bool,
    /// Errors block pre-events only when explicitly enabled.
    #[serde(default, rename = "failClosed")]
    pub fail_closed: bool,
    /// Enabled by default for user-authored entries.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Accepted schema major (default 1).
    #[serde(default = "one")]
    pub schema_version: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HookDefinitionInput {
    /// Unique id within the user file.
    id: String,
    /// Optional display name.
    name: Option<String>,
    /// Event to receive.
    event: HookEvent,
    /// Tool filter, only for tool events.
    #[serde(default, rename = "match")]
    matcher: HookMatcher,
    /// command or http.
    #[serde(rename = "type")]
    kind: String,
    /// Shell command; mutually exclusive with args.
    command: Option<String>,
    /// Executable and literal argv; no shell.
    args: Option<Vec<String>>,
    /// http(s) endpoint; http hooks only.
    url: Option<String>,
    /// Literal environment additions.
    #[serde(default)]
    env: BTreeMap<String, String>,
    /// Timeout in milliseconds (default 30 seconds).
    #[serde(default)]
    timeout_ms: Option<u64>,
    /// Observe-only background execution.
    #[serde(default, rename = "async")]
    asynchronous: bool,
    /// Errors block pre-events only when explicitly enabled.
    #[serde(default, rename = "failClosed")]
    fail_closed: bool,
    /// Enabled by default for user-authored entries.
    #[serde(default = "yes")]
    enabled: bool,
    /// Accepted schema major (default 1).
    #[serde(default = "one")]
    schema_version: u32,
}
/// The rest of `url` after a case-insensitive `scheme`.
fn after_scheme<'a>(url: &'a str, scheme: &str) -> Option<&'a str> {
    url.get(..scheme.len())
        .filter(|prefix| prefix.eq_ignore_ascii_case(scheme))
        .and_then(|_| url.get(scheme.len()..))
}
/// The host of an authority: brackets kept, port removed; empty when malformed.
fn authority_host(authority: &str) -> &str {
    if authority.starts_with('[') {
        return authority.split_once(']').map_or("", |(_, rest)| {
            if rest.is_empty() || rest.starts_with(':') {
                &authority[..authority.len() - rest.len()]
            } else {
                ""
            }
        });
    }
    authority
        .rsplit_once(':')
        .map_or(authority, |(host, _)| host)
}
/// http(s) with a host and no user info, which Settings and logs would show;
/// plain http only to a loopback host, so payloads never cross a network in
/// clear text. Anything else malformed fails at request time like an
/// unreachable host.
fn check_http_url(url: &str) -> Result<(), &'static str> {
    const INVALID: &str = "HTTP hooks need an http(s) URL without credentials";
    if url.len() > 2048 || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(INVALID);
    }
    let (plain, rest) = match (after_scheme(url, "https://"), after_scheme(url, "http://")) {
        (Some(rest), _) => (false, rest),
        (_, Some(rest)) => (true, rest),
        _ => return Err(INVALID),
    };
    // A backslash ends the authority in the URL parser that sends the request.
    let authority = rest.split(['/', '\\', '?', '#']).next().unwrap_or_default();
    let host = authority_host(authority);
    if host.is_empty() || authority.contains('@') {
        return Err(INVALID);
    }
    let scheme = if plain { "http" } else { "https" };
    if !hook_transport_allowed(scheme, Some(host)) {
        return Err("HTTP hooks need https:// unless the host is loopback");
    }
    Ok(())
}
/// The transport rule, for a URL parser's scheme and host: https anywhere,
/// plain http only to a loopback host.
pub fn hook_transport_allowed(scheme: &str, host: Option<&str>) -> bool {
    match scheme {
        "https" => host.is_some(),
        "http" => host.is_some_and(loopback_host),
        _ => false,
    }
}
/// `localhost` or a loopback IP address (an IPv6 one in brackets). Names that
/// only resemble these, such as `127.0.0.1.example.com`, are not loopback.
fn loopback_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    let address = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host);
    address
        .parse::<std::net::IpAddr>()
        .is_ok_and(|address| address.to_canonical().is_loopback())
}
/// A signing secret: long enough to resist guessing and to be redacted from
/// logs. The error never repeats the value.
pub fn check_hook_secret(secret: &str) -> Result<(), &'static str> {
    if (16..=1024).contains(&secret.len()) && !secret.chars().any(char::is_control) {
        Ok(())
    } else {
        Err("Hook secrets need 16 to 1024 characters without control characters")
    }
}
fn yes() -> bool {
    true
}
fn one() -> u32 {
    1
}
impl HookDefinition {
    /// Match one tool without regex or content predicates.
    pub fn matches(&self, tool: Option<&str>) -> bool {
        self.enabled
            && (self.matcher.tools.is_empty()
                || tool.is_some_and(|tool| {
                    self.matcher.tools.iter().any(|pattern| {
                        pattern
                            .strip_suffix('*')
                            .map_or(pattern == tool, |prefix| tool.starts_with(prefix))
                    })
                }))
    }
    /// A command needs exactly one of command/args; an http hook only its URL.
    fn validate_transport(&self) -> Result<(), String> {
        match self.kind.as_str() {
            "command" => {
                let command = self.command.as_ref().is_some_and(|v| !v.trim().is_empty());
                let args = self
                    .args
                    .as_ref()
                    .is_some_and(|v| v.first().is_some_and(|s| !s.is_empty()));
                if command == args
                    || (self.command.is_some() && self.args.is_some())
                    || self.url.is_some()
                {
                    return Err("Choose command or executable args".into());
                }
                Ok(())
            }
            "http" => {
                if self.command.is_some() || self.args.is_some() || !self.env.is_empty() {
                    return Err("HTTP hooks take a URL, not a command or environment".into());
                }
                check_http_url(self.url.as_deref().unwrap_or_default()).map_err(str::to_owned)
            }
            _ => Err("Only command and http hooks are supported".into()),
        }
    }
    /// Name for safe diagnostics.
    pub fn label(&self) -> &str {
        self.name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(&self.id)
    }
}
impl HookConfig {
    /// Enforce phase-one limits before publishing any registry.
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 || self.hooks.len() > 64 {
            return Err("Expected version 1 and at most 64 hooks".into());
        }
        let mut ids = HashSet::new();
        for hook in &self.hooks {
            if hook.id.is_empty()
                || hook.id.len() > 128
                || !ids.insert(&hook.id)
                || !hook
                    .id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            {
                return Err("Hook ids must be unique letters, numbers, '-' or '_'".into());
            }
            if hook.schema_version != 1 {
                return Err("Only hooks accepting schema 1 are supported".into());
            }
            hook.validate_transport()?;
            let cap = if hook.asynchronous { 600_000 } else { 120_000 };
            if hook.timeout_ms == 0
                || hook.timeout_ms > cap
                || (hook.asynchronous && hook.event.blocks())
            {
                return Err("Invalid timeout or async pre-event".into());
            }
            if !hook.matcher.tools.is_empty() && !hook.event.tool_event() {
                return Err("Tool matchers require a tool event".into());
            }
            if hook
                .matcher
                .tools
                .iter()
                .any(|s| s.is_empty() || s.trim_end_matches('*').contains('*') || s.ends_with("**"))
            {
                return Err("Tool matchers use exact names or one trailing '*'".into());
            }
            if hook.env.keys().any(|s| {
                s.is_empty()
                    || s.contains('=')
                    || s.contains('\0')
                    || s.eq_ignore_ascii_case("BUTLER_DATA")
            }) {
                return Err("Invalid hook environment".into());
            }
            if self.hooks.iter().filter(|h| h.event == hook.event).count() > 16 {
                return Err("At most 16 hooks per event".into());
            }
        }
        Ok(())
    }
}

impl<'de> Deserialize<'de> for HookDefinition {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let input = HookDefinitionInput::deserialize(deserializer)?;
        Ok(Self {
            id: input.id,
            name: input.name,
            event: input.event,
            matcher: input.matcher,
            kind: input.kind,
            command: input.command,
            args: input.args,
            url: input.url,
            env: input.env,
            timeout_ms: input.timeout_ms.unwrap_or(if input.asynchronous {
                60_000
            } else {
                30_000
            }),
            asynchronous: input.asynchronous,
            fail_closed: input.fail_closed,
            enabled: input.enabled,
            schema_version: input.schema_version,
        })
    }
}
