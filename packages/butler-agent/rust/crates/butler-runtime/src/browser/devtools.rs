//! Read-only DevTools access for a conversation's tab: what of its console,
//! network and DOM may reach the model. No script the model writes ever runs;
//! the page's reply is untrusted data.
pub(super) mod dom;
pub(super) mod mask;
pub(super) mod names;
pub use dom::selector_allowed as devtools_selector_allowed;
use mask::{mask_headers, mask_text, mask_url};
use serde_json::{Map, Value, json};

/// The host op of a read.
pub const DEVTOOLS_OP: &str = "tab.devtools";
const PAGE_SIZE: usize = 100;
/// Well under the 256 KiB a host reply may be, with room for the reply's own fields.
const PAGE_BYTES: usize = 200 * 1024;

/// `localhost`, `*.localhost`, a loopback IP.
pub fn local_url(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    match url.host() {
        Some(url::Host::Domain(host)) => {
            let host = host.trim_end_matches('.').to_ascii_lowercase();
            host == "localhost" || host.ends_with(".localhost")
        }
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

fn failed(entry: &Value) -> bool {
    entry["status"].as_u64().is_some_and(|status| status >= 400) || entry["error"].is_string()
}

/// One page of a tab's rows, newest last: as many as fit the size a host reply
/// may have, with how many remain. Hosts page, so a long log never overflows
/// the reply and nothing is left out unsaid.
pub(super) fn page_of<'a>(rows: impl Iterator<Item = &'a Value>, args: &Value) -> Value {
    let rows: Vec<&Value> = rows
        .filter(|row| args["only_failed"] != true || failed(row))
        .collect();
    let total = rows.len();
    let offset = args["offset"]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(0)
        .min(total);
    let end = total - offset;
    let mut start = end;
    let mut bytes = 0;
    while start > 0 && end - start < PAGE_SIZE {
        let size = rows[start - 1].to_string().len();
        if bytes + size > PAGE_BYTES {
            break;
        }
        bytes += size;
        start -= 1;
    }
    json!({"total":total,"older":start,"next_offset":(start > 0).then_some(total - start),
        "entries":rows[start..end]})
}

/// The paging facts of a host's reply beside the rows it may show.
fn paged(report: &Value, entries: &[Value]) -> Value {
    let total = report["total"].as_u64().unwrap_or(entries.len() as u64);
    json!({"total":total,"returned":entries.len(),"older":report["older"].as_u64().unwrap_or(0),
        "next_offset":report["next_offset"],"entries":entries})
}

fn console(report: &Value) -> Value {
    let entries: Vec<Value> = report["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|entry| {
            let mut row = Map::new();
            row.insert("level".into(), entry["level"].clone());
            row.insert(
                "text".into(),
                json!(mask_text(entry["text"].as_str().unwrap_or(""))),
            );
            if let Some(source) = entry["source"].as_str().filter(|s| !s.is_empty()) {
                row.insert("source".into(), json!(mask_url(source)));
                row.insert("line".into(), entry["line"].clone());
            }
            Value::Object(row)
        })
        .collect();
    paged(report, &entries)
}

/// A payment provider's URLs carry the checkout itself: a row says only where.
fn row_url(raw: &str) -> String {
    match url::Url::parse(raw) {
        Ok(url)
            if matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some_and(super::payment_host) =>
        {
            url.origin().ascii_serialization()
        }
        _ => mask_url(raw),
    }
}

/// A request as a row: allow-listed facts only, so whatever else a host
/// reports (cookies, bodies, request headers) stops here.
fn network_row(entry: &Value) -> Value {
    let mut row = Map::new();
    row.insert(
        "url".into(),
        json!(row_url(entry["url"].as_str().unwrap_or(""))),
    );
    for field in [
        "method", "type", "status", "mime", "bytes", "ms", "cached", "state",
    ] {
        if !entry[field].is_null() {
            row.insert(field.into(), entry[field].clone());
        }
    }
    if let Some(error) = entry["error"].as_str() {
        row.insert("error".into(), json!(mask_text(error)));
    }
    if let Some(headers) = mask_headers(&entry["response_headers"]) {
        row.insert("response_headers".into(), headers);
    }
    Value::Object(row)
}

fn network(report: &Value) -> Value {
    let entries: Vec<Value> = report["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .map(network_row)
        .collect();
    paged(report, &entries)
}

fn document(report: &Value) -> Value {
    let nodes = report["nodes"].as_array().map_or(&[][..], Vec::as_slice);
    let rendered = dom::render(nodes);
    let complete = rendered.omitted_nodes == 0 && report["walked_all"] == true;
    json!({"html":rendered.html,"rendered_nodes":rendered.rendered_nodes,
        "omitted_nodes":rendered.omitted_nodes,"total_elements":report["total_elements"],
        "complete":complete,"selector_matched":report["selector_matched"],
        "recovery":(!complete).then_some("Pass selector to read a narrower part of the document.")})
}

/// What of a read reaches the model: the page's data under `untrusted_content`,
/// masked, with what was masked said out loud.
pub fn devtools_reply(report: &Value) -> Value {
    let read = report["read"].as_str().unwrap_or("");
    let mut data = match read {
        "console" => console(report),
        "network" => network(report),
        "dom" => document(report),
        _ => return json!({"status":"unknown","reason":"invalid_result"}),
    };
    data["kind"] = json!("web_page_data");
    data["url"] = json!(mask_url(report["url"].as_str().unwrap_or("")));
    if read != "dom" {
        data["dropped_oldest"] = json!(report["dropped"].as_u64().unwrap_or(0));
        data["since_page_load"] = json!(report["from_load"] == true);
    }
    json!({"status":"ok","schema":"butler.browser-devtools.v1","tab":report["tab"],"read":read,
        "masked":["cookies","credential_headers","credential_parameters","bodies","field_values"],
        "untrusted_content":data})
}
