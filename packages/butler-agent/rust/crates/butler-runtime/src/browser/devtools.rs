//! Read-only DevTools access for a conversation's tab: where the tab stands at
//! read time, and what of its console, network and DOM may reach the model.
//! No script the model writes ever runs; the page's reply is untrusted data.
pub(super) mod dom;
pub(super) mod mask;
pub(super) mod names;
pub use dom::selector_allowed as devtools_selector_allowed;
use mask::{mask_headers, mask_text, mask_url};
use serde_json::{Map, Value, json};

/// Host ops. The first says where the tab is now; the second reads it.
pub const DEVTOOLS_PLACE_OP: &str = "tab.devtools_place";
pub const DEVTOOLS_READ_OP: &str = "tab.devtools";
const PAGE_SIZE: usize = 100;
/// Well under the 256 KiB a host reply may be, with room for the reply's own fields.
const PAGE_BYTES: usize = 200 * 1024;

pub fn is_devtools_op(op: &str) -> bool {
    op == DEVTOOLS_PLACE_OP || op == DEVTOOLS_READ_OP
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DevtoolsPlace {
    /// A page Butler made, or a local dev server the user opened: never asks.
    Local,
    /// A loopback page that a page navigated the tab to: asks every time, masked.
    LocalMoved,
    /// A site this tab holds no sign-in for: asks once per site.
    SignedOut,
    /// A tab that uses the owner's sign-ins: asks every time, reads masked.
    SignedIn,
}

impl DevtoolsPlace {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::LocalMoved => "local_moved",
            Self::SignedOut => "signed_out",
            Self::SignedIn => "signed_in",
        }
    }
}

/// A tab's standing at the moment the host looked at it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DevtoolsStanding {
    pub place: DevtoolsPlace,
    /// Registrable domain (an IP as is); empty for a local page, and host and
    /// port for one a page moved the tab to.
    pub site: String,
    pub host: String,
    /// Whether this looks like the user's sign-in: what the card says.
    pub signed_in: bool,
    /// Account-bound data is masked: a sign-in, or a page that moved the tab.
    pub masked: bool,
}

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

/// Where a host report puts the tab; `Err` names why it cannot be read at all.
pub fn devtools_standing(report: &Value) -> Result<DevtoolsStanding, &'static str> {
    let raw = report["url"].as_str().ok_or("navigation_denied")?;
    let url = url::Url::parse(raw).map_err(|_| "navigation_denied")?;
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    // A list that overflowed cannot rule a sign-in out, so it reads as one.
    let unknown = report["credentials_overflow"] == true;
    let profile_signed_in = report["profile"] == "signed_in" || unknown;
    let seen = || {
        report["credentialed_hosts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
    };
    if local_url(raw) {
        let signed_in = profile_signed_in || seen().any(|one| one == host);
        if report["local_trusted"] != true {
            let site = url
                .port()
                .map_or_else(|| host.clone(), |port| format!("{host}:{port}"));
            return Ok(DevtoolsStanding {
                place: DevtoolsPlace::LocalMoved,
                site,
                host,
                signed_in,
                masked: true,
            });
        }
        return Ok(DevtoolsStanding {
            place: DevtoolsPlace::Local,
            site: String::new(),
            host,
            signed_in,
            masked: signed_in,
        });
    }
    super::public_url(raw)?;
    if super::payment_host(&host) {
        return Err("payment_page");
    }
    let site = super::site_of(raw).ok_or("navigation_denied")?;
    let credentialed = seen().any(|one| super::site_of_host(one).as_deref() == Some(site.as_str()));
    let signed_in = profile_signed_in || credentialed;
    Ok(DevtoolsStanding {
        place: if signed_in {
            DevtoolsPlace::SignedIn
        } else {
            DevtoolsPlace::SignedOut
        },
        site,
        host,
        signed_in,
        masked: signed_in,
    })
}

/// The authority target a card and a standing permission bind to.
pub fn devtools_scope(place: DevtoolsPlace, site: &str) -> String {
    match place {
        DevtoolsPlace::SignedIn => super::signed_in_scope(site),
        DevtoolsPlace::SignedOut | DevtoolsPlace::Local | DevtoolsPlace::LocalMoved => {
            format!("browser:signed_out:{site}")
        }
    }
}

/// The place reply: enough to decide, nothing read from the page.
pub fn devtools_place_reply(report: &Value, standing: &DevtoolsStanding) -> Value {
    json!({"status":"ok","tab":report["tab"],"place":standing.place.as_str(),
        "site":standing.site,"host":standing.host,"masked":standing.masked,
        "mode":if standing.signed_in { "signed_in" } else { "signed_out" }})
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

fn console(report: &Value, masked: bool) -> Value {
    let entries: Vec<Value> = report["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|entry| {
            let mut row = Map::new();
            row.insert("level".into(), entry["level"].clone());
            row.insert(
                "text".into(),
                json!(mask_text(entry["text"].as_str().unwrap_or(""), masked)),
            );
            if let Some(source) = entry["source"].as_str().filter(|s| !s.is_empty()) {
                row.insert("source".into(), json!(mask_url(source, masked)));
                row.insert("line".into(), entry["line"].clone());
            }
            Value::Object(row)
        })
        .collect();
    paged(report, &entries)
}

/// A request as a row: allow-listed facts only, so whatever else a host
/// reports (cookies, bodies, request headers) stops here.
fn network_row(entry: &Value, masked: bool) -> Value {
    let mut row = Map::new();
    row.insert(
        "url".into(),
        json!(mask_url(entry["url"].as_str().unwrap_or(""), masked)),
    );
    for field in [
        "method", "type", "status", "mime", "bytes", "ms", "cached", "state",
    ] {
        if !entry[field].is_null() {
            row.insert(field.into(), entry[field].clone());
        }
    }
    if let Some(error) = entry["error"].as_str() {
        row.insert("error".into(), json!(mask_text(error, masked)));
    }
    if let Some(headers) = mask_headers(&entry["response_headers"], masked) {
        row.insert("response_headers".into(), headers);
    }
    Value::Object(row)
}

fn network(report: &Value, masked: bool) -> Value {
    let entries: Vec<Value> = report["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|entry| network_row(entry, masked))
        .collect();
    paged(report, &entries)
}

fn document(report: &Value, masked: bool) -> Value {
    let nodes = report["nodes"].as_array().map_or(&[][..], Vec::as_slice);
    let rendered = dom::render(nodes, masked);
    let complete = rendered.omitted_nodes == 0 && report["walked_all"] == true;
    json!({"html":rendered.html,"rendered_nodes":rendered.rendered_nodes,
        "omitted_nodes":rendered.omitted_nodes,"total_elements":report["total_elements"],
        "complete":complete,"selector_matched":report["selector_matched"],
        "recovery":(!complete).then_some("Pass selector to read a narrower part of the document.")})
}

/// What of a read reaches the model: the page's data under `untrusted_content`,
/// masked for `standing`, with what was masked said out loud.
pub fn devtools_read_reply(report: &Value, standing: &DevtoolsStanding) -> Value {
    let masked = standing.masked;
    let read = report["read"].as_str().unwrap_or("");
    let mut data = match read {
        "console" => console(report, masked),
        "network" => network(report, masked),
        "dom" => document(report, masked),
        _ => return json!({"status":"unknown","reason":"invalid_result"}),
    };
    data["kind"] = json!("web_page_data");
    data["url"] = json!(mask_url(report["url"].as_str().unwrap_or(""), masked));
    if read != "dom" {
        data["dropped_oldest"] = json!(report["dropped"].as_u64().unwrap_or(0));
        data["since_page_load"] = json!(report["from_load"] == true);
    }
    json!({"status":"ok","schema":"butler.browser-devtools.v1","tab":report["tab"],"read":read,
        "place":standing.place.as_str(),"site":standing.site,
        "masked":if masked {
            json!(["cookies","headers","bodies","query_values","field_values"])
        } else {
            json!(["cookies","credential_headers","bodies","field_values"])
        },
        "untrusted_content":data})
}
