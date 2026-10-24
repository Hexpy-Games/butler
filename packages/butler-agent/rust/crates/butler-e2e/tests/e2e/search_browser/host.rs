//! This test as the App browser host: tabs that open the fixture's pages and
//! answer reads and observations with their text. No screenshots exist here.
use butler_e2e::e2e::{HarnessError, security::AdminClient};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    sync::{LazyLock, Mutex, atomic::AtomicUsize},
    time::Duration,
};

/// Every browser call frame the host received, in order.
pub(super) static LOG: LazyLock<Mutex<Vec<Value>>> = LazyLock::new(Mutex::default);
/// The most `tab.open` frames that were pending at once.
pub(super) static PARALLEL_OPENS: AtomicUsize = AtomicUsize::new(0);

pub(crate) struct Host {
    stream: reqwest::Response,
    buffer: String,
    admin: AdminClient,
    tabs: Vec<Value>,
}

pub(super) fn page_text(url: &str) -> String {
    let name = url.rsplit('/').next().unwrap_or("page");
    format!("Spring tides {name}: the {name} table lists the highest spring tide at 6.1 m.")
}

impl Host {
    pub(crate) async fn attach(admin: AdminClient) -> Result<Self, HarnessError> {
        let stream = reqwest::Client::new()
            .get(format!("{}/internal/browser-host", admin.gw.base))
            .bearer_auth(&admin.gw.token)
            .header("x-butler-admin", &admin.admin)
            .send()
            .await?;
        assert_eq!(stream.status(), 200);
        Ok(Self {
            stream,
            buffer: String::new(),
            admin,
            tabs: Vec::new(),
        })
    }

    async fn next(&mut self) -> Result<Value, HarnessError> {
        loop {
            if let Some(end) = self.buffer.find("\n\n") {
                let event = self.buffer[..end].to_owned();
                self.buffer.drain(..end + 2);
                if let Some(data) = event.lines().find_map(|l| l.strip_prefix("data: ")) {
                    return Ok(serde_json::from_str(data)?);
                }
            } else {
                let bytes = self.stream.chunk().await?.expect("host connected");
                self.buffer.push_str(std::str::from_utf8(&bytes).unwrap());
            }
        }
    }

    async fn reply(&self, frame: &Value, result: Value) -> Result<(), HarnessError> {
        let route = if frame["op"] == "tab.read" {
            "renders"
        } else {
            "results"
        };
        let path = format!(
            "/internal/browser-host/{route}/{}",
            frame["id"].as_str().unwrap()
        );
        let reply = self
            .admin
            .send(Method::POST, &path, Some(result), &[])
            .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        Ok(())
    }

    /// Answers browser calls until the test ends. `tab.open` frames that
    /// arrive together are answered together, after the last one arrives.
    pub(crate) async fn serve(mut self) -> Result<(), HarnessError> {
        let mut opens = Vec::new();
        loop {
            let frame = if opens.is_empty() {
                self.next().await?
            } else {
                match tokio::time::timeout(Duration::from_secs(2), self.next()).await {
                    Ok(frame) => frame?,
                    Err(_) => {
                        self.open_all(std::mem::take(&mut opens)).await?;
                        continue;
                    }
                }
            };
            let op = frame["op"].as_str().unwrap_or("").to_owned();
            if op.starts_with("use.") || frame["id"].is_null() {
                continue;
            }
            LOG.lock().unwrap().push(frame.clone());
            if op == "tab.open" {
                opens.push(frame);
                if opens.len() == 3 {
                    self.open_all(std::mem::take(&mut opens)).await?;
                }
                continue;
            }
            let answer = self.answer(&op, &frame);
            self.reply(&frame, answer).await?;
        }
    }

    async fn open_all(&mut self, opens: Vec<Value>) -> Result<(), HarnessError> {
        PARALLEL_OPENS.fetch_max(opens.len(), std::sync::atomic::Ordering::SeqCst);
        for frame in &opens {
            let id = format!("t{}", self.tabs.len() + 1);
            self.tabs.push(json!({"id":id,"owner":format!("conversation:{}",frame["session"].as_str().unwrap()),
                "profile":"signed_out","epoch":1,"holder":"agent","inUse":false,"agent":true,
                "url":frame["args"]["url"],"title":"Tide table"}));
        }
        let reply = self
            .admin
            .send(
                Method::POST,
                "/internal/browser-host/events",
                Some(json!({"tabs":self.tabs})),
                &[],
            )
            .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        let first = self.tabs.len() - opens.len();
        for (frame, tab) in opens.iter().zip(self.tabs[first..].to_vec()) {
            let opened = json!({"status":"ok","tab":tab["id"],"url":tab["url"],"title":"Tide table","epoch":1,"profile":"signed_out"});
            self.reply(frame, opened).await?;
        }
        Ok(())
    }

    fn answer(&self, op: &str, frame: &Value) -> Value {
        let tab = self.tabs.iter().find(|tab| tab["id"] == frame["tab"]);
        let url = tab.and_then(|tab| tab["url"].as_str()).unwrap_or("");
        let text = page_text(url);
        match (op, tab) {
            ("tabs.list", _) => json!({"tabs":self.tabs}),
            ("tab.read", Some(tab)) => json!({"status":"ok","tab":tab["id"],"url":url,"epoch":1,
                "html":format!("<!doctype html><html><head><title>Tide table</title></head><body><main><article><h1>Tide table</h1><p>{text}</p>{}<p>End of the tide table.</p></article></main></body></html>", "<p>Each entry lists the date, time and height of high and low water.</p>".repeat(60))}),
            ("tab.observe", Some(tab)) => {
                json!({"status":"ok","tab":tab["id"],"obs":"o1","epoch":1,"url":url,
                "frames":[{"id":"f0","url":url,"class":"main"}],
                "text":format!("tab {} epoch 1 obs o1\nheading \"Tide table\" [f0-e1]\n{text}", tab["id"].as_str().unwrap()),
                "nodes":[{"ref":"f0-e1","role":"heading","name":"Tide table"}],"fields":[],"layout_regions":[],
                "capture_regions":[],"hidden":{"invisible":0,"low_contrast":0,"tiny":0},
                "totals":{"interactive":0,"below_fold":0},"payment":false,"addons":[]})
            }
            _ => json!({"status":"refused","reason":"unsupported_op"}),
        }
    }
}
