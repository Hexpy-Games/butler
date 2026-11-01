use super::{GUARD, Mode};
use butler_e2e::e2e::{
    HarnessError,
    events::{LiveEvents, turn_event_kind},
    security::AdminClient,
};
use reqwest::Method;
use serde_json::{Value, json};
use std::sync::Arc;

pub(super) struct Host {
    stream: reqwest::Response,
    admin: AdminClient,
    events: Arc<LiveEvents>,
    mode: Mode,
    tabs: Vec<Value>,
    updated: bool,
    reads: usize,
    observed: bool,
    held: Option<Value>,
}

impl Host {
    pub(super) async fn attach(
        admin: AdminClient,
        events: Arc<LiveEvents>,
        mode: Mode,
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
            admin,
            events,
            mode,
            tabs: Vec::new(),
            updated: false,
            reads: 0,
            observed: false,
            held: None,
        })
    }

    pub(super) async fn serve(mut self) -> Result<usize, HarnessError> {
        let mut buffer = String::new();
        loop {
            let frame =
                super::super::browser_delegation::next_frame(&mut self.stream, &mut buffer).await?;
            let op = frame["op"].as_str().unwrap();
            let result = match op {
                "use.started" | "use.ended" => continue,
                "use.finished" => return Ok(self.reads),
                "tab.waiting" => json!({"status":"ok"}),
                "tab.open" => self.open(&frame).await?,
                "tabs.list" => json!({"tabs":self.tabs}),
                "tab.observe" if !self.observed => {
                    self.observed = true;
                    json!({"status":"ok","tab":"A","obs":"obs-A",
                        "url":"https://example.com/A","text":"button Update [e1]"})
                }
                "tab.prepare" => json!({"status":"ok","tab":"A","url":"https://example.com/A",
                    "steps":[{"hit":{"role":"button","name":"Update","frame":""}}]}),
                "tab.act" => {
                    if matches!(self.mode, Mode::Different) && self.reads == 0 {
                        self.held = Some(frame);
                        continue;
                    }
                    self.action(&frame).await?;
                    continue;
                }
                "tab.observe" => {
                    self.reads += 1;
                    let title = if self.updated {
                        "Updated page"
                    } else {
                        "Original page"
                    };
                    let text = format!(
                        "button Update [e1]\n{}",
                        format!("{title} contains the full document and all its details. ")
                            .repeat(8)
                    );
                    let result = json!({"status":"ok","tab":frame["tab"],"obs":"obs-read",
                        "url":format!("https://example.com/{}",frame["tab"].as_str().unwrap()),"text":text});
                    self.reply(&frame, result.clone()).await?;
                    if let Some(held) = self.held.take() {
                        if matches!(self.mode, Mode::Shared) {
                            self.reply(&held, result).await?;
                        } else {
                            self.action(&held).await?;
                        }
                    }
                    continue;
                }
                _ => panic!("unexpected browser op {op}"),
            };
            self.reply(&frame, result).await?;
        }
    }

    async fn started(&self, call: &str) -> Result<(), HarnessError> {
        self.events
            .wait_for(GUARD, |e| {
                turn_event_kind(e) == Some("tool.started")
                    && e["payload"]["event"]["payload"]["toolCallId"] == call
            })
            .await?;
        Ok(())
    }

    async fn action(&mut self, frame: &Value) -> Result<(), HarnessError> {
        // Hold the action reply until its positive operation event is observed.
        // The negative check in the parent uses event order, not an absence timeout:
        // join_all polls the read while the action is pending at the host. This
        // relies on its started event reaching the progress writer before the
        // action's completed event; see execute() and TurnProgressScope::emit().
        self.started(if matches!(self.mode, Mode::Reverse) {
            "batch-1"
        } else {
            "batch-0"
        })
        .await?;
        self.updated = true;
        self.reply(
            frame,
            json!({"status":"ok","tab":"A","completed":1,
            "steps":[{"status":"completed","hit":{"role":"button","name":"Update"}}]}),
        )
        .await
    }

    async fn open(&mut self, frame: &Value) -> Result<Value, HarnessError> {
        let url = frame["args"]["url"].as_str().unwrap();
        let id = url.rsplit('/').next().unwrap();
        self.tabs
            .push(json!({"id":id,"url":url,"owner":"conversation:general",
            "profile":"signed_out","epoch":1,"holder":"agent","inUse":false}));
        let sent = self
            .admin
            .send(
                Method::POST,
                "/internal/browser-host/events",
                Some(json!({"tabs":self.tabs})),
                &[],
            )
            .await?;
        assert_eq!(sent.status, 200, "{}", sent.text);
        Ok(json!({"status":"ok","tab":id,"url":url,"epoch":1,"profile":"signed_out"}))
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
        let sent = self
            .admin
            .send(Method::POST, &path, Some(result), &[])
            .await?;
        assert_eq!(sent.status, 200, "{}", sent.text);
        Ok(())
    }
}
