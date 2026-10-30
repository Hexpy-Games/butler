//! Read-only DevTools access for a conversation's tab: where the tab stands at
//! read time, and what of its console, network and DOM may reach the model.
//! No script the model writes ever runs; the page's reply is untrusted data.
pub mod dom;
pub mod mask;
use mask::{mask_headers, mask_text, mask_url};
use serde_json::{Map, Value, json};

/// Host ops. The first says where the tab is now; the second reads it.
pub const PLACE_OP: &str = "tab.devtools_place";
pub const READ_OP: &str = "tab.devtools";
const PAGE_SIZE: usize = 100;
/// Well under the 256 KiB a host reply may be, with room for the reply's own fields.
const PAGE_BYTES: usize = 200 * 1024;

pub fn is_op(op: &str) -> bool {
    op == PLACE_OP || op == READ_OP
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Place {
    /// A page Butler made, or a local dev server: never asks.
    Local,
    /// A site this tab holds no sign-in for: asks once per site.
    SignedOut,
    /// A tab that uses the owner's sign-ins: asks every time, reads masked.
    SignedIn,
}

impl Place {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::SignedOut => "signed_out",
            Self::SignedIn => "signed_in",
        }
    }
}

/// A tab's standing at the moment the host looked at it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Standing {
    pub place: Place,
    /// Registrable domain (an IP as is); empty for a local page.
    pub site: String,
    pub host: String,
    /// Account-bound data is masked: a signed-in profile or observed credentials.
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
pub fn standing(report: &Value) -> Result<Standing, &'static str> {
    let raw = report["url"].as_str().ok_or("navigation_denied")?;
    let url = url::Url::parse(raw).map_err(|_| "navigation_denied")?;
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let profile_signed_in = report["profile"] == "signed_in";
    if local_url(raw) {
        return Ok(Standing {
            place: Place::Local,
            site: String::new(),
            host,
            masked: profile_signed_in,
        });
    }
    super::public_url(raw)?;
    if super::payment_host(&host) {
        return Err("payment_page");
    }
    let site = super::site_of(raw).ok_or("navigation_denied")?;
    let credentialed = report["credentialed_hosts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|seen| super::site_of_host(seen).as_deref() == Some(site.as_str()));
    let signed_in = profile_signed_in || credentialed;
    Ok(Standing {
        place: if signed_in {
            Place::SignedIn
        } else {
            Place::SignedOut
        },
        site,
        host,
        masked: signed_in,
    })
}

/// The authority target a card and a standing permission bind to.
pub fn scope(place: Place, site: &str) -> String {
    match place {
        Place::SignedIn => super::signed_in_scope(site),
        Place::SignedOut | Place::Local => format!("browser:signed_out:{site}"),
    }
}

/// The place reply: enough to decide, nothing read from the page.
pub fn place_reply(report: &Value, standing: &Standing) -> Value {
    json!({"status":"ok","tab":report["tab"],"place":standing.place.as_str(),
        "site":standing.site,"host":standing.host,"masked":standing.masked})
}

fn failed(entry: &Value) -> bool {
    entry["status"].as_u64().is_some_and(|status| status >= 400) || entry["error"].is_string()
}

/// One page of a tab's rows, newest last: as many as fit the size a host reply
/// may have, with how many remain. Hosts page, so a long log never overflows
/// the reply and nothing is left out unsaid.
pub fn page_of<'a>(rows: impl Iterator<Item = &'a Value>, args: &Value) -> Value {
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
fn paged(report: &Value, entries: Vec<Value>) -> Value {
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
    paged(report, entries)
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
    paged(report, entries)
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
pub fn read_reply(report: &Value, standing: &Standing) -> Value {
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
            json!(["cookies","credential_headers","bodies","secret_fields"])
        },
        "untrusted_content":data})
}

#[cfg(test)]
mod tests {
    use super::*;

    // test-category: security
    #[test]
    fn standing_follows_the_reported_page() {
        let at = |url: &str, profile: &str| standing(&json!({"url":url,"profile":profile}));
        let out = at("https://shop.example.com/a", "signed_out").unwrap();
        assert_eq!(
            (out.place, out.site.as_str(), out.masked),
            (Place::SignedOut, "example.com", false)
        );
        let signed = at("https://shop.example.com/a", "signed_in").unwrap();
        assert_eq!((signed.place, signed.masked), (Place::SignedIn, true));
        for url in [
            "http://localhost:3000/",
            "http://app.localhost/",
            "http://127.0.0.1:9/__o/x",
            "http://[::1]:5173/",
        ] {
            assert_eq!(at(url, "signed_out").unwrap().place, Place::Local, "{url}");
        }
        assert!(at("http://localhost:3000/", "signed_in").unwrap().masked);
        assert_eq!(
            at("http://192.168.0.2/", "signed_out"),
            Err("navigation_denied")
        );
        assert_eq!(
            at("https://checkout.stripe.com/", "signed_out"),
            Err("payment_page")
        );
    }

    // test-category: security
    #[test]
    fn credentials_seen_on_the_site_make_a_signed_out_tab_signed_in() {
        let report = json!({"url":"https://www.example.com/","profile":"signed_out","credentialed_hosts":["api.example.com"]});
        let result = standing(&report).unwrap();
        assert_eq!((result.place, result.masked), (Place::SignedIn, true));
        let other = json!({"url":"https://www.other.com/","profile":"signed_out","credentialed_hosts":["api.example.com"]});
        assert_eq!(standing(&other).unwrap().place, Place::SignedOut);
    }

    // test-category: security
    #[test]
    fn rows_are_allow_listed_and_pages_count_what_they_leave_out() {
        let report = json!({"read":"network","url":"https://a.example/","entries":[
            {"url":"https://a.example/x?q=1","method":"POST","status":500,"request_body":"pw=1",
             "response_body":"leaked-body","request_headers":{"cookie":"a=b"},"response_headers":{"set-cookie":"a=b","content-type":"text/plain"}}]});
        let standing_out = Standing {
            place: Place::SignedOut,
            site: "a.example".into(),
            host: "a.example".into(),
            masked: false,
        };
        let plain = read_reply(&report, &standing_out).to_string();
        for leak in ["pw=1", "leaked-body", "a=b"] {
            assert!(!plain.contains(leak), "{plain}");
        }
        assert!(plain.contains("text/plain"), "{plain}");
        let signed = Standing {
            place: Place::SignedIn,
            masked: true,
            ..standing_out
        };
        let masked = read_reply(&report, &signed).to_string();
        assert!(
            !masked.contains("text/plain") && !masked.contains("q=1"),
            "{masked}"
        );
        let rows: Vec<Value> = (0..250)
            .map(|i| json!({"level":"error","text":format!("e{i}"),"status":if i % 2 == 0 {500} else {200}}))
            .collect();
        let first = page_of(rows.iter(), &json!({}));
        assert_eq!(first["entries"].as_array().unwrap().len(), 100);
        assert_eq!(first["entries"][99]["text"], "e249");
        assert_eq!(first["next_offset"], 100);
        let last = page_of(rows.iter(), &json!({"offset":200}));
        assert_eq!(last["entries"].as_array().unwrap().len(), 50);
        assert_eq!(last["older"], 0);
        assert!(last["next_offset"].is_null());
        let failed_only = page_of(rows.iter(), &json!({"only_failed":true}));
        assert_eq!(failed_only["total"], 125);
        let long: Vec<Value> = (0..100)
            .map(|_| json!({"text":"한".repeat(4000)}))
            .collect();
        let bounded = page_of(long.iter(), &json!({}));
        assert!(bounded.to_string().len() < 256 * 1024);
        assert_eq!(
            bounded["older"].as_u64().unwrap()
                + bounded["entries"].as_array().unwrap().len() as u64,
            100
        );
    }
}
