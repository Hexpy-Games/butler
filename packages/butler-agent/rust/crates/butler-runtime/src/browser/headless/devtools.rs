//! DevTools capture for a headless tab: console errors and request rows kept
//! from page events the tab already receives, bounded, and cleared when the
//! main frame commits a new document. Nothing is kept of cookies or bodies.
use super::{page::Page, scripts::scripts};
use crate::browser::devtools::{mask::credential_name, page_of};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};

const MAX_CONSOLE: usize = 200;
const MAX_NETWORK: usize = 500;
const MAX_HOSTS: usize = 256;
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
    /// Hosts whose traffic showed a credential: a sent `Authorization`, or an
    /// HttpOnly cookie set in answer to a state-changing request.
    credentialed: HashSet<String>,
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
    fn note_host(&mut self, url: &str, page_url: &str) {
        for host in [url, page_url].into_iter().filter_map(host_of) {
            if self.credentialed.len() < MAX_HOSTS {
                self.credentialed.insert(host);
            }
        }
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
                    let url = self.pending.get(id).map_or(String::new(), |row| {
                        row["url"].as_str().unwrap_or("").to_owned()
                    });
                    self.note_host(&url, page_url);
                }
            }
            "Network.responseReceivedExtraInfo" => self.set_cookies(id, params, page_url),
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
        self.pending.insert(
            id.to_owned(),
            json!({"method":params["request"]["method"],
                "url":capped(params["request"]["url"].as_str().unwrap_or(""), MAX_TEXT),
                "type":params["type"],"loader":params["loaderId"],
                "started":params["timestamp"],"state":"pending"}),
        );
    }

    fn set_cookies(&mut self, id: &str, params: &Value, page_url: &str) {
        let cookies = header(&params["headers"], "set-cookie").unwrap_or("");
        let Some(row) = self.pending.get(id) else {
            return;
        };
        let changing = !matches!(row["method"].as_str(), Some("GET" | "HEAD"));
        if changing && cookies.to_ascii_lowercase().contains("httponly") {
            let url = row["url"].as_str().unwrap_or("").to_owned();
            self.note_host(&url, page_url);
        }
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
        self.console.clear();
        self.dropped_console = 0;
        self.network.retain(|row| row["loader"] == *loader);
        self.dropped_network = 0;
        self.pending.retain(|_, row| row["loader"] == *loader);
    }

    fn hosts(&self) -> Vec<&String> {
        self.credentialed.iter().collect()
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

/// Where the tab is now, from the live tab state.
pub(crate) fn place(page: &Page) -> Value {
    page.shared
        .with_tab(&page.tab, |tab| {
            json!({"status":"ok","tab":tab.id,"url":tab.url,"profile":"signed_out",
            "credentialed_hosts":tab.devtools.hosts()})
        })
        .unwrap_or_else(|| json!({"status":"not_dispatched","reason":"not_your_tab"}))
}

async fn document(page: &Page, args: &Value) -> Result<Value, String> {
    let context = page.world(&page.session, &page.target).await?;
    let script = scripts()
        .ok_or("scripts_unavailable")?
        .devtools_dom(&json!({"selector":args["selector"]}));
    page.evaluate_in(&page.session, context, &script).await
}

/// One read. A tab that committed another page meanwhile answers that, so a
/// read is never reported against the page it did not come from.
pub(crate) async fn read(page: &Page, args: &Value) -> Result<Value, String> {
    let read = args["read"].as_str().unwrap_or("");
    let before = place(page);
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
    if place(page)["url"] != before["url"] {
        return Ok(
            json!({"status":"not_dispatched","reason":"devtools_page_changed",
            "recovery":"The tab moved during this read. Call browser_devtools again."}),
        );
    }
    for key in ["status", "tab", "url", "profile", "credentialed_hosts"] {
        result[key] = before[key].clone();
    }
    result["read"] = json!(read);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    // test-category: security
    #[test]
    fn capture_keeps_no_credentials_and_ends_with_the_document() {
        let mut tools = Devtools::default();
        tools.event(
            "Network.requestWillBeSent",
            &json!({"requestId":"1","loaderId":"a","timestamp":1.0,"type":"XHR",
            "request":{"url":"https://api.example.com/login","method":"POST"}}),
            "https://www.example.com/",
            true,
        );
        tools.event(
            "Network.responseReceivedExtraInfo",
            &json!({"requestId":"1",
            "headers":{"Set-Cookie":"sid=1; HttpOnly"}}),
            "https://www.example.com/",
            true,
        );
        tools.event(
            "Network.responseReceived",
            &json!({"requestId":"1","response":{"status":500,"mimeType":"text/plain",
            "headers":{"set-cookie":"sid=1","content-type":"text/plain"}}}),
            "https://www.example.com/",
            true,
        );
        tools.event(
            "Network.loadingFinished",
            &json!({"requestId":"1","timestamp":1.25,"encodedDataLength":9}),
            "https://www.example.com/",
            true,
        );
        let rows = tools.read_network(&json!({}));
        assert_eq!(rows["entries"][0]["ms"], 250);
        assert_eq!(rows["entries"][0]["bytes"], 9);
        assert!(!rows.to_string().contains("sid=1"), "{rows}");
        let hosts = tools.hosts();
        assert!(hosts.iter().any(|host| *host == "api.example.com"));
        assert!(hosts.iter().any(|host| *host == "www.example.com"));

        tools.event(
            "Runtime.exceptionThrown",
            &json!({"exceptionDetails":{"text":"boom"}}),
            "https://www.example.com/",
            true,
        );
        tools.event(
            "Page.frameNavigated",
            &json!({"frame":{"id":"f","loaderId":"b"}}),
            "https://other.example/",
            true,
        );
        assert_eq!(tools.read_network(&json!({}))["entries"], json!([]));
        assert_eq!(tools.read_console(&json!({}))["entries"], json!([]));
    }
}
