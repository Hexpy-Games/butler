//! This test as the App browser host. The reader's render of the page shows
//! only its shell; a tab shows the whole listing once its scripts ran.
use base64::Engine;
use butler_e2e::e2e::{HarnessError, security::AdminClient};
use reqwest::Method;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub(super) type Log = Arc<Mutex<Vec<Value>>>;

pub(super) struct Host {
    stream: reqwest::Response,
    buffer: String,
    admin: AdminClient,
    tabs: Vec<Value>,
    log: Log,
}

const SHELL: &str = "<!doctype html><html><head><title>Desk lamps</title></head><body><div id=\"app\"><h1>Desk lamps</h1><p>Loading products…</p></div></body></html>";

impl Host {
    pub(super) async fn attach(admin: AdminClient, log: Log) -> Result<Self, HarnessError> {
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
            log,
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

    /// Answers browser calls until the test ends.
    pub(super) async fn serve(mut self) -> Result<(), HarnessError> {
        loop {
            let frame = self.next().await?;
            let op = frame["op"].as_str().unwrap_or("").to_owned();
            if op.starts_with("use.") || frame["id"].is_null() {
                continue;
            }
            self.log.lock().unwrap().push(frame.clone());
            let answer = if op == "tab.open" {
                self.open(&frame).await?
            } else {
                self.answer(&op, &frame)
            };
            self.reply(&frame, answer).await?;
        }
    }

    async fn open(&mut self, frame: &Value) -> Result<Value, HarnessError> {
        let id = format!("t{}", self.tabs.len() + 1);
        let tab = json!({"id":id,"owner":format!("conversation:{}",frame["session"].as_str().unwrap()),
            "profile":"signed_out","epoch":1,"holder":"agent","inUse":false,"agent":true,
            "url":frame["args"]["url"],"title":"Desk lamps"});
        self.tabs.push(tab.clone());
        let events = self
            .admin
            .send(
                Method::POST,
                "/internal/browser-host/events",
                Some(json!({"tabs":self.tabs})),
                &[],
            )
            .await?;
        assert_eq!(events.status, 200, "{}", events.text);
        Ok(
            json!({"status":"ok","tab":id,"url":tab["url"],"title":"Desk lamps","epoch":1,"profile":"signed_out"}),
        )
    }

    fn answer(&self, op: &str, frame: &Value) -> Value {
        let tab = self.tabs.iter().find(|tab| tab["id"] == frame["tab"]);
        match (op, tab) {
            ("reader.render", _) => {
                json!({"status":"ok","final_url":frame["args"]["url"],"http_status":200,
                "html_base64":base64::engine::general_purpose::STANDARD.encode(SHELL)})
            }
            ("tabs.list", _) => json!({"tabs":self.tabs}),
            ("tab.observe", Some(tab)) => {
                json!({"status":"ok","tab":tab["id"],"url":tab["url"],"obs":"o1",
                "text":"Aurora: 450 lm. Beacon: 1200 lm. Cinder: 800 lm."})
            }
            _ => json!({"status":"refused","reason":"unsupported_op"}),
        }
    }
}
