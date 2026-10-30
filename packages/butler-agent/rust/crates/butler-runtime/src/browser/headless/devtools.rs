//! DevTools capture for a headless tab: console errors and request rows kept
//! from page events the tab already receives, bounded, and cleared when the
//! main frame commits a new document. Nothing is kept of cookies or bodies.
use super::{page::Page, scripts::scripts};
use crate::browser::devtools::{
    DEVTOOLS_PLACE_OP, local_url,
    names::{credential_header, credential_name, login_cookie, password_field},
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
const LIVE_URL_TRIES: usize = 5;
const LIVE_URL_WAIT: std::time::Duration = std::time::Duration::from_millis(100);

#[derive(Default)]
pub(crate) struct Devtools {
    console: VecDeque<Value>,
    network: VecDeque<Value>,
    pending: HashMap<String, Value>,
    dropped_console: u64,
    dropped_network: u64,
    /// Hosts whose traffic sent a credential header, until the state takes them.
    seen: HashSet<String>,
    /// The main frame's last commit: what a read that runs no page script reports.
    committed_url: Option<String>,
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
    fn note_credential(&mut self, headers: &Value, page_url: &str) {
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
    pub(crate) fn event(
        &mut self,
        method: &str,
        params: &Value,
        page_url: &str,
        (main, main_frame): (bool, &str),
    ) {
        let id = params["requestId"].as_str().unwrap_or("");
        match method {
            "Network.requestWillBeSent" => self.request(id, params),
            "Network.requestWillBeSentExtraInfo" => {
                let sent = params["headers"].as_object();
                if sent.is_some_and(|sent| sent.keys().any(|name| credential_header(name))) {
                    self.note_credential(&params["headers"], page_url);
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
            "Page.navigatedWithinDocument" if main && params["frameId"] == main_frame => {
                self.committed_url = params["url"].as_str().map(str::to_owned);
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
        self.committed_url = Some(url.to_owned());
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

/// Whether an error means the page went from under a call, as a commit does.
fn page_gone(error: &str) -> bool {
    error == "frame_unavailable" || error == "tab_closed" || error.contains("context")
}

/// The address the page itself reports. While a document commits there is no
/// page to ask for a moment.
async fn page_url(page: &Page) -> Result<String, String> {
    let mut failure = String::new();
    for _ in 0..LIVE_URL_TRIES {
        let asked = async {
            let context = page.world(&page.session, &page.target).await?;
            page.evaluate_in(&page.session, context, "location.href")
                .await
        };
        match asked.await {
            Ok(href) => return Ok(href.as_str().unwrap_or("").to_owned()),
            Err(error) if page_gone(&error) => failure = error,
            Err(error) => return Err(error),
        }
        tokio::time::sleep(LIVE_URL_WAIT).await;
    }
    Err(failure)
}

/// The tab's address. Only a DOM read asks the page; the console and network
/// must still answer when its script has hung, from what the tab last committed.
async fn current_url(page: &Page, ask_page: bool) -> Result<String, String> {
    if ask_page {
        return page_url(page).await;
    }
    page.shared
        .with_tab(&page.tab, |tab| {
            tab.devtools
                .committed_url
                .clone()
                .unwrap_or_else(|| tab.url.clone())
        })
        .ok_or_else(|| "tab_closed".to_owned())
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
                cookie["domain"]
                    .as_str()
                    .unwrap_or("")
                    .trim_start_matches('.'),
            )
        })
        .filter_map(|cookie| cookie["domain"].as_str())
        .map(|domain| domain.trim_start_matches('.').to_ascii_lowercase())
        .collect())
}

/// Where the tab is now: the page's own address, and at this moment what its
/// browser context shows of a sign-in.
async fn place(page: &Page, ask_page: bool) -> Result<Value, String> {
    let url = current_url(page, ask_page).await?;
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

/// A password going into a field by Butler's own hand is a sign-in in progress,
/// whatever the site keeps afterwards.
pub(crate) fn note_password_entry(page: &Page, hit: &Value) {
    if !password_field(hit["name"].as_str().unwrap_or("")) {
        return;
    }
    let mut state = page.shared.lock();
    let Some(tab) = state.tabs.get(&page.tab) else {
        return;
    };
    let (context, host) = (tab.context.clone(), host_of(&tab.url));
    state
        .credentials
        .entry(context)
        .or_default()
        .add(host.into_iter().collect());
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
    let reply = if op == DEVTOOLS_PLACE_OP {
        checked_place(page, args).await
    } else {
        read(page, args).await
    };
    // A page that went away mid-call is one that moved; anything else is an error.
    match reply {
        Err(error) if page_gone(&error) => Ok(moved()),
        reply => reply,
    }
}

fn moved() -> Value {
    json!({"status":"not_dispatched","reason":"devtools_page_changed",
        "recovery":"The tab moved during this read. Call browser_devtools again."})
}

async fn checked_place(page: &Page, args: &Value) -> Result<Value, String> {
    if let Some(selector) = args["selector"].as_str()
        && !selector_valid(page, selector).await?
    {
        return Ok(json!({"status":"not_dispatched","reason":"invalid_selector"}));
    }
    place(page, args["read"] == "dom").await
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
    let ask_page = read == "dom";
    let before = current_url(page, ask_page).await?;
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
    let after = place(page, ask_page).await?;
    let moved_during = result["href"].as_str().is_some_and(|href| href != before);
    if moved_during || after["url"] != before.as_str() {
        return Ok(moved());
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
