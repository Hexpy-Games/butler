use super::{Result, json};
use async_imap::types::Fetch;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use mail_parser::{Address, Message, MessageParser, MimeHeaders};
use serde_json::{Map, Value};

pub(super) const HEADERS: &[&str] = &[
    "List-Id",
    "List-Unsubscribe",
    "List-Unsubscribe-Post",
    "Precedence",
    "Auto-Submitted",
    "Reply-To",
    "Sender",
    "In-Reply-To",
    "Message-ID",
];
pub(super) struct Id {
    pub mailbox: String,
    pub validity: u32,
    pub uid: u32,
}
impl Id {
    pub(super) fn encode(&self) -> String {
        format!(
            "{}:{}:{}",
            URL_SAFE_NO_PAD.encode(&self.mailbox),
            self.validity,
            self.uid
        )
    }
    pub(super) fn parse(value: &str) -> Result<Self> {
        let mut parts = value.split(':');
        let mailbox = String::from_utf8(
            URL_SAFE_NO_PAD
                .decode(parts.next().ok_or("mail_event_invalid")?)
                .map_err(|_| "mail_event_invalid")?,
        )
        .map_err(|_| "mail_event_invalid")?;
        let validity = parts
            .next()
            .ok_or("mail_event_invalid")?
            .parse()
            .map_err(|_| "mail_event_invalid")?;
        let uid = parts
            .next()
            .ok_or("mail_event_invalid")?
            .parse()
            .map_err(|_| "mail_event_invalid")?;
        if parts.next().is_some() || mailbox.is_empty() || uid == 0 {
            return Err("mail_event_invalid");
        }
        Ok(Self {
            mailbox,
            validity,
            uid,
        })
    }
}
pub(super) fn normalize(value: &str) -> String {
    value.trim().trim_matches(['<', '>']).to_ascii_lowercase()
}
fn contains(addresses: Option<&Address<'_>>, account: &str) -> bool {
    addresses.is_some_and(|a| {
        a.iter().any(|a| {
            a.address
                .as_deref()
                .is_some_and(|s| s.eq_ignore_ascii_case(account))
        })
    })
}
pub(super) fn event(fetch: &Fetch, id: &Id, account: &str) -> Result<Value> {
    let mut bytes = fetch.header().ok_or("mail_headers_missing")?.to_vec();
    bytes.extend_from_slice(fetch.text().unwrap_or_default());
    let parsed = MessageParser::default()
        .parse(&bytes)
        .ok_or("mail_parse_failed")?;
    let dedupe = parsed
        .message_id()
        .map(normalize)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| id.encode());
    let thread = parsed
        .references()
        .as_text_list()
        .and_then(|ids| ids.first())
        .map(|s| normalize(s))
        .unwrap_or_else(|| dedupe.clone());
    let mut attrs = Map::new();
    for header in HEADERS {
        if let Some(value) = parsed.header_raw(*header) {
            attrs.insert((*header).into(), attribute(value.trim()).into());
        }
    }
    attrs.insert("mailbox".into(), attribute(&id.mailbox).into());
    let from = parsed.from().and_then(|a| a.iter().next());
    let addressing = if contains(parsed.to(), account) {
        "direct"
    } else if contains(parsed.cc(), account) {
        "member"
    } else {
        "broadcast"
    };
    let received = fetch
        .internal_date()
        .ok_or("mail_date_missing")?
        .to_rfc3339();
    Ok(
        json!({"id":id.encode(),"dedupe_key":dedupe,"thread_id":thread,"received_at":received,
        "from":{"display":from.and_then(|a|a.name.as_deref()).unwrap_or_default(),"address":from.and_then(|a|a.address.as_deref()).unwrap_or_default()},
        "addressing":addressing,"subject":parsed.subject().unwrap_or_default(),
        "snippet":parsed.body_text(0).unwrap_or_default().chars().take(1000).collect::<String>(),"attributes":attrs}),
    )
}
pub(super) fn context(bytes: &[u8]) -> Result<Value> {
    let parsed = MessageParser::default()
        .parse(bytes)
        .ok_or("mail_parse_failed")?;
    let headers = parsed
        .headers_raw()
        .map(|(k, v)| json!({"name":k,"value":v.trim()}))
        .collect::<Vec<_>>();
    let body = (0..parsed.text_body.len().max(parsed.html_body.len()))
        .filter_map(|i| parsed.body_text(i))
        .map(std::borrow::Cow::into_owned)
        .collect::<Vec<_>>()
        .join("\n");
    let attachments = parsed
        .attachments()
        .map(|p| json!({"name":p.attachment_name().unwrap_or_default(),"size":p.contents().len()}))
        .collect::<Vec<_>>();
    Ok(json!({"headers":headers,"body":body,"attachments":attachments}))
}
pub(super) fn parse(bytes: &[u8]) -> Result<Message<'_>> {
    MessageParser::default()
        .parse(bytes)
        .ok_or("mail_parse_failed")
}

fn attribute(value: &str) -> &str {
    let mut end = value.len().min(4096);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.get(..end).unwrap_or_default()
}
