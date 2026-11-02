//! This test as the App browser host: tabs that open the fixture's pages and
//! answer reads and observations with their text. No screenshots exist here.
use base64::Engine;
use butler_e2e::e2e::{HarnessError, security::AdminClient};
use reqwest::Method;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub(crate) struct Host {
    stream: reqwest::Response,
    buffer: String,
    admin: AdminClient,
    tabs: Vec<Value>,
    task: Arc<super::fixture::Task>,
    pub(super) log: Option<Arc<Mutex<Vec<Value>>>>,
}

impl Host {
    pub(super) async fn attach(
        admin: AdminClient,
        task: Arc<super::fixture::Task>,
        capture: bool,
    ) -> Result<Self, HarnessError> {
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
            task,
            log: capture.then(|| Arc::new(Mutex::new(Vec::new()))),
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
        if let Some(log) = &self.log {
            log.lock()
                .unwrap()
                .push(json!({"frame":frame,"reply":result}));
        }
        let route = if matches!(frame["op"].as_str(), Some("tab.read" | "reader.render")) {
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

    pub(super) fn start(self) -> Serving {
        Serving(tokio::spawn(self.serve()))
    }
    async fn serve(mut self) -> Result<(), HarnessError> {
        loop {
            let frame = self.next().await?;
            let op = frame["op"].as_str().unwrap_or("").to_owned();
            if op.starts_with("use.") || frame["id"].is_null() {
                continue;
            }
            if op == "tab.open" {
                self.open_all(vec![frame]).await?;
            } else {
                self.reply(&frame, self.answer(&op, &frame)).await?;
            }
        }
    }

    async fn open_all(&mut self, opens: Vec<Value>) -> Result<(), HarnessError> {
        for frame in &opens {
            let id = format!("t{}", self.tabs.len() + 1);
            self.tabs.push(json!({"id":id,"owner":format!("conversation:{}",frame["session"].as_str().unwrap()),
                "profile":"signed_out","epoch":1,"holder":"agent","inUse":false,"agent":true,
                "url":frame["args"]["url"],"title":self.task.pages.get(frame["args"]["url"].as_str().unwrap_or("")).map(|p|p.0.as_str()).unwrap_or("Not found")}));
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
            let opened = json!({"status":"ok","tab":tab["id"],"url":tab["url"],"title":tab["title"],"epoch":1,"profile":"signed_out"});
            self.reply(frame, opened).await?;
        }
        Ok(())
    }

    fn answer(&self, op: &str, frame: &Value) -> Value {
        let tab = self.tabs.iter().find(|tab| tab["id"] == frame["tab"]);
        let url = if op == "reader.render" {
            frame["args"]["url"].as_str().unwrap_or("")
        } else {
            tab.and_then(|tab| tab["url"].as_str()).unwrap_or("")
        };
        let missing = (
            "Not found".to_owned(),
            "<html><body><h1>Not found</h1></body></html>".to_owned(),
        );
        let (title, html) = self.task.pages.get(url).unwrap_or(&missing);
        let text = visible_text(html);
        match (op, tab) {
            ("reader.render", _) => json!({"status":"ok","final_url":url,"http_status":200,
                "html_base64":base64::engine::general_purpose::STANDARD.encode(html)}),
            ("tabs.list", _) => json!({"tabs":self.tabs}),
            ("tab.read", Some(tab)) => json!({"status":"ok","tab":tab["id"],"url":url,"epoch":1,
                "html":html}),
            ("tab.observe", Some(tab)) => {
                json!({"status":"ok","tab":tab["id"],"obs":"o1","epoch":1,"url":url,
                "frames":[{"id":"f0","url":url,"class":"main"}],
                "text":format!("tab {} epoch 1 obs o1\n{title}\n{text}", tab["id"].as_str().unwrap()),
                "nodes":[{"ref":"f0-e1","role":"heading","name":title}],"fields":[],"layout_regions":[],
                "capture_regions":[],"hidden":{"invisible":0,"low_contrast":0,"tiny":0},
                "totals":{"interactive":0,"below_fold":0},"payment":false,"addons":[]})
            }
            _ => json!({"status":"refused","reason":"unsupported_op"}),
        }
    }
}

pub(super) struct Serving(tokio::task::JoinHandle<Result<(), HarnessError>>);
impl Drop for Serving {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn visible_text(html: &str) -> String {
    let document = dom_query::Document::from(html);
    document
        .select("script, style, noscript, template, [hidden], [aria-hidden='true']")
        .remove();
    document
        .select("body")
        .formatted_text()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
