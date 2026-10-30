//! DevTools capture for a headless tab: console errors and request rows kept
//! from page events the tab already receives, bounded, and cleared when the
//! main frame commits a new document. Nothing is kept of cookies or bodies.
use super::{page::Page, scripts::scripts};
use crate::browser::devtools::{
    DEVTOOLS_PLACE_OP, local_url,
    mask::{credential_name, login_cookie},
    page_of,
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};

const MAX_CONSOLE: usize = 200;
const MAX_NETWORK: usize = 500;
const MAX_PENDING: usize = 500;
const MAX_HOSTS: usize = 64;
const MAX_TEXT: usize = 4000;
const MAX_HEADERS: usize = 40;
const MAX_HEADER_VALUE: usize = 500;

#[derive(Default)]
pub(crate) struct Devtools {
    console: VecDeque<Value>,
    network: VecDeque<Value>,
    pending: HashMap<String, Value>,
    dropped_console: u64,
    dropped_network: u64,
    /// Hosts whose traffic sent an `Authorization`, until the state takes them.
    seen: HashSet<String>,
    /// A commit away from loopback: a local page after it was not simply opened.
    left_local: bool,
}

/// What a browser context's traffic showed; it outlives the tabs that showed it.
#[derive(Default)]
pub(crate) struct Credentials {
    hosts: HashSet<String>,
    overflow: bool,
}

impl Credentials {
    pub(crate) fn add(&mut self, seen: HashSet<String>) {
        for host in seen {
            if self.hosts.len() < MAX_HOSTS {
                self.hosts.insert(host);
            } else {
                self.overflow = true;
            }
        }
    }
}

fn host_of(url: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()?
        .host_str()
        .map(str::to_ascii_lowercase)
}

fn capped(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

fn millis(seconds: f64) -> u64 {
    let value = (seconds * 1000.0).round();
    if value.is_finite() && value > 0.0 {
        format!("{value:.0}").parse().unwrap_or(0)
    } else {
        0
    }
}

fn header<'a>(headers: &'a Value, name: &str) -> Option<&'a str> {
    headers
        .as_object()?
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .and_then(|(_, value)| value.as_str())
}

impl Devtools {
    pub(crate) fn take_seen(&mut self) -> HashSet<String> {
        std::mem::take(&mut self.seen)
    }

    /// The request's own host comes from its headers, which cannot name the
    /// wrong hop of a redirect; the page it ran on counts too.
    fn note_authorization(&mut self, headers: &Value, page_url: &str) {
        let named = header(headers, ":authority")
            .or_else(|| header(headers, "host"))
            .and_then(|host| host_of(&format!("http://{host}")));
        self.seen.extend(named.into_iter().chain(host_of(page_url)));
    }

    fn add_console(&mut self, entry: Value) {
        if self.console.len() == MAX_CONSOLE {
            self.console.pop_front();
            self.dropped_console += 1;
        }
        self.console.push_back(entry);
    }

    fn finish(&mut self, id: &str, end: &Value, error: Option<&str>) {
        let Some(mut row) = self.pending.remove(id) else {
            return;
        };
        if let (Some(start), Some(end)) = (row["started"].as_f64(), end.as_f64()) {
            row["ms"] = json!(millis(end - start));
        }
        if let Some(record) = row.as_object_mut() {
            record.remove("started");
            record.remove("state");
        }
        if let Some(error) = error {
            row["error"] = json!(error);
        }
        if self.network.len() == MAX_NETWORK {
            self.network.pop_front();
            self.dropped_network += 1;
        }
        self.network.push_back(row);
    }

    /// Applies one page event. `main` says it came from the tab's own session.
    pub(crate) fn event(&mut self, method: &str, params: &Value, page_url: &str, main: bool) {
        let id = params["requestId"].as_str().unwrap_or("");
        match method {
            "Network.requestWillBeSent" => self.request(id, params),
            "Network.requestWillBeSentExtraInfo" => {
                if header(&params["headers"], "authorization").is_some() {
                    self.note_authorization(&params["headers"], page_url);
                }
            }
            "Network.responseReceived" => self.response(id, params),
            "Network.loadingFinished" => {
                if let Some(row) = self.pending.get_mut(id)
                    && let Some(bytes) = params["encodedDataLength"].as_u64()
                {
                    row["bytes"] = json!(bytes);
                }
                self.finish(id, &params["timestamp"], None);
            }
            "Network.loadingFailed" => {
                let error = params["blockedReason"]
                    .as_str()
                    .or_else(|| params["errorText"].as_str())
                    .unwrap_or("failed")
                    .to_owned();
                self.finish(id, &params["timestamp"], Some(&error));
            }
            "Runtime.consoleAPICalled" if main && params["type"] == "error" => {
                let first = &params["args"][0];
                let text = first["value"]
                    .as_str()
                    .or_else(|| first["description"].as_str())
                    .unwrap_or("");
                let frame = &params["stackTrace"]["callFrames"][0];
                self.add_console(json!({"level":"error","text":capped(text, MAX_TEXT),
                    "source":frame["url"],"line":frame["lineNumber"]}));
            }
            "Runtime.exceptionThrown" if main => {
                let details = &params["exceptionDetails"];
                let text = details["exception"]["description"]
                    .as_str()
                    .or_else(|| details["text"].as_str())
                    .unwrap_or("");
                self.add_console(json!({"level":"error","text":capped(text, MAX_TEXT),
                    "source":details["url"],"line":details["lineNumber"]}));
            }
            "Page.frameNavigated" if main && params["frame"]["parentId"].is_null() => {
                self.committed(&params["frame"]);
            }
            _ => {}
        }
    }

    fn request(&mut self, id: &str, params: &Value) {
        // A redirect reuses the request id: the hop before it ends here.
        if !params["redirectResponse"].is_null() {
            if let Some(row) = self.pending.get_mut(id) {
                row["status"] = params["redirectResponse"]["status"].clone();
            }
            self.finish(id, &params["timestamp"], None);
        }
        if self.pending.len() >= MAX_PENDING
            && let Some(oldest) = self
                .pending
                .iter()
                .min_by(|a, b| {
                    let started = |row: &Value| row["started"].as_f64().unwrap_or(0.0);
                    started(a.1).total_cmp(&started(b.1))
                })
                .map(|(key, _)| key.clone())
        {
            self.pending.remove(&oldest);
            self.dropped_network += 1;
        }
        self.pending.insert(
            id.to_owned(),
            json!({"method":params["request"]["method"],
                "url":capped(params["request"]["url"].as_str().unwrap_or(""), MAX_TEXT),
                "type":params["type"],"loader":params["loaderId"],
                "started":params["timestamp"],"state":"pending"}),
        );
    }

    fn response(&mut self, id: &str, params: &Value) {
        let Some(row) = self.pending.get_mut(id) else {
            return;
        };
        let response = &params["response"];
        row["status"] = response["status"].clone();
        row["mime"] = response["mimeType"].clone();
        row["cached"] =
            json!(response["fromDiskCache"] == true || response["fromServiceWorker"] == true);
        if response["status"]
            .as_u64()
            .is_some_and(|status| status >= 400)
            && let Some(headers) = response["headers"].as_object()
        {
            let kept: serde_json::Map<String, Value> = headers
                .iter()
                .filter(|(name, _)| !credential_name(name))
                .take(MAX_HEADERS)
                .map(|(name, value)| {
                    let value = capped(value.as_str().unwrap_or(""), MAX_HEADER_VALUE);
                    (name.clone(), Value::String(value))
                })
                .collect();
            row["response_headers"] = Value::Object(kept);
        }
    }

    /// A new document: what the old one logged and requested is not its data.
    fn committed(&mut self, frame: &Value) {
        let loader = &frame["loaderId"];
        let url = frame["url"].as_str().unwrap_or("");
        if url.starts_with("http") && !local_url(url) {
            self.left_local = true;
        }
        self.console.clear();
        self.dropped_console = 0;
        self.network.retain(|row| row["loader"] == *loader);
        self.dropped_network = 0;
        self.pending.retain(|_, row| row["loader"] == *loader);
    }

    fn read_console(&self, args: &Value) -> Value {
        let mut page = page_of(self.console.iter(), args);
        page["dropped"] = json!(self.dropped_console);
        page["from_load"] = json!(true);
        page
    }

    fn read_network(&self, args: &Value) -> Value {
        let rows = self.network.iter().chain(self.pending.values());
        let mut page = page_of(rows, args);
        page["dropped"] = json!(self.dropped_network);
        page["from_load"] = json!(true);
        page
    }
}

/// The address the page itself reports, not the last one a target event named.
async fn live_url(page: &Page) -> Result<String, String> {
    let context = page.world(&page.session, &page.target).await?;
    let href = page
        .evaluate_in(&page.session, context, "location.href")
        .await?;
    Ok(href.as_str().unwrap_or("").to_owned())
}

/// Every host with a cookie that looks like a sign-in, from the context's store.
async fn cookie_hosts(page: &Page, context: &str) -> Result<HashSet<String>, String> {
    let params = if context.is_empty() {
        json!({})
    } else {
        json!({"browserContextId":context})
    };
    let reply = page.cdp.send("Storage.getCookies", params, None).await?;
    Ok(reply["cookies"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|cookie| {
            login_cookie(
                cookie["name"].as_str().unwrap_or(""),
                cookie["httpOnly"] == true,
            )
        })
        .filter_map(|cookie| cookie["domain"].as_str())
        .map(|domain| domain.trim_start_matches('.').to_ascii_lowercase())
        .collect())
}

/// Where the tab is now: the page's own address, and at this moment what its
/// browser context shows of a sign-in.
async fn place(page: &Page) -> Result<Value, String> {
    let url = live_url(page).await?;
    let (id, context, mut hosts, mut overflow, left_local) = {
        let state = page.shared.lock();
        let Some(tab) = state.tabs.get(&page.tab) else {
            return Ok(json!({"status":"not_dispatched","reason":"not_your_tab"}));
        };
        let seen = state.credentials.get(&tab.context);
        (
            tab.id.clone(),
            tab.context.clone(),
            seen.map(|one| one.hosts.clone()).unwrap_or_default(),
            seen.is_some_and(|one| one.overflow),
            tab.devtools.left_local,
        )
    };
    match cookie_hosts(page, &context).await {
        Ok(found) => hosts.extend(found),
        // An unread store cannot rule a sign-in out.
        Err(_) => overflow = true,
    }
    if hosts.len() > MAX_HOSTS {
        overflow = true;
    }
    let hosts: Vec<String> = hosts.into_iter().take(MAX_HOSTS).collect();
    Ok(
        json!({"status":"ok","tab":id,"url":url,"profile":"signed_out",
        "credentialed_hosts":hosts,"credentials_overflow":overflow,"local_trusted":!left_local}),
    )
}

async fn selector_valid(page: &Page, selector: &str) -> Result<bool, String> {
    let context = page.world(&page.session, &page.target).await?;
    let script = scripts()
        .ok_or("scripts_unavailable")?
        .devtools_selector(&json!(selector));
    let valid = page.evaluate_in(&page.session, context, &script).await?;
    Ok(valid == true)
}

pub(crate) async fn call(page: &Page, op: &str, args: &Value) -> Result<Value, String> {
    if op == DEVTOOLS_PLACE_OP {
        if let Some(selector) = args["selector"].as_str()
            && !selector_valid(page, selector).await?
        {
            return Ok(json!({"status":"not_dispatched","reason":"invalid_selector"}));
        }
        return place(page).await;
    }
    read(page, args).await
}

async fn document(page: &Page, args: &Value) -> Result<Value, String> {
    let context = page.world(&page.session, &page.target).await?;
    let script = scripts()
        .ok_or("scripts_unavailable")?
        .devtools_dom(&json!({"selector":args["selector"]}));
    page.evaluate_in(&page.session, context, &script).await
}

/// One read. A tab that committed another page meanwhile answers that, so a
/// read is never reported against the page it did not come from. The report
/// is taken after the read: a sign-in that appeared meanwhile counts.
async fn read(page: &Page, args: &Value) -> Result<Value, String> {
    let read = args["read"].as_str().unwrap_or("");
    let before = live_url(page).await?;
    let mut result = match read {
        "console" => page
            .shared
            .with_tab(&page.tab, |tab| tab.devtools.read_console(args))
            .ok_or("tab_closed")?,
        "network" => page
            .shared
            .with_tab(&page.tab, |tab| tab.devtools.read_network(args))
            .ok_or("tab_closed")?,
        "dom" => document(page, args).await?,
        _ => return Ok(json!({"status":"not_dispatched","reason":"invalid_read"})),
    };
    if result["invalid_selector"] == true {
        return Ok(json!({"status":"not_dispatched","reason":"invalid_selector"}));
    }
    let after = place(page).await?;
    let moved = result["href"].as_str().is_some_and(|href| href != before);
    if moved || after["url"] != before.as_str() {
        return Ok(
            json!({"status":"not_dispatched","reason":"devtools_page_changed",
            "recovery":"The tab moved during this read. Call browser_devtools again."}),
        );
    }
    for key in [
        "status",
        "tab",
        "url",
        "profile",
        "credentialed_hosts",
        "credentials_overflow",
        "local_trusted",
    ] {
        result[key] = after[key].clone();
    }
    result["read"] = json!(read);
    Ok(result)
}
