//! A scripted public page and a signed-in account page on the real host
//! stream: each ref resolves to fixed facts, as the App executor reports them.
use butler_e2e::e2e::{
    HarnessError, cassette::Cassette, scenario::Scenario, security::AdminClient,
};
use reqwest::Method;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub(super) const PUBLIC: &str = "https://shop.example.test/";
pub(super) const ACCOUNT: &str = "https://account.example.test/";

pub(crate) struct Host {
    frames: Arc<Mutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Host {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Host {
    /// Attaches the host and publishes the public and signed-in tabs.
    pub(crate) async fn attach(s: &Scenario) -> Result<Self, HarnessError> {
        let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
        let mut stream = reqwest::Client::new()
            .get(format!("{}/internal/browser-host", s.gw.base))
            .bearer_auth(&s.gw.token)
            .header("x-butler-admin", &admin.admin)
            .send()
            .await?;
        assert_eq!(stream.status(), 200);
        let tabs = json!([
            tab("pub", "signed_out", PUBLIC),
            tab("acct", "signed_in", ACCOUNT)
        ]);
        let reply = admin
            .send(
                Method::POST,
                "/internal/browser-host/events",
                Some(json!({ "tabs": tabs })),
                &[],
            )
            .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        let frames = Arc::new(Mutex::new(Vec::new()));
        let seen = frames.clone();
        let granting = admin.clone();
        let task = tokio::spawn(async move {
            let mut buffer = String::new();
            loop {
                let Ok(frame) =
                    super::super::browser_delegation::next_frame(&mut stream, &mut buffer).await
                else {
                    return;
                };
                let op = frame["op"].as_str().unwrap_or("").to_owned();
                if op.starts_with("use.") {
                    continue;
                }
                let mut recorded = frame.clone();
                if op == "tab.act" {
                    let uploaded: Vec<_> = frame["args"]["steps"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|step| step["action"] == "upload")
                        .map(|step| {
                            std::fs::read_to_string(step["value"].as_str().unwrap()).unwrap()
                        })
                        .collect();
                    recorded["uploaded_content"] = json!(uploaded);
                }
                seen.lock().unwrap().push(recorded);
                let id = frame["id"].as_str().unwrap_or("").to_owned();
                let _ = admin
                    .send(
                        Method::POST,
                        &format!("/internal/browser-host/results/{id}"),
                        Some(respond(&op, &frame)),
                        &[],
                    )
                    .await;
            }
        });
        // The user already allowed signed-in use of the account site here.
        let grant = json!({"op":"signin.grant","session":"general","tab":"","args":{"site":"example.test"}});
        let reply = granting
            .send(Method::POST, "/internal/browser/calls", Some(grant), &[])
            .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        Ok(Self { frames, task })
    }

    /// Every dispatched host op, in order.
    pub(crate) fn ops(&self) -> Vec<String> {
        self.frames
            .lock()
            .unwrap()
            .iter()
            .filter_map(|frame| frame["op"].as_str().map(str::to_owned))
            .collect()
    }

    pub(super) fn uploads(&self) -> Vec<String> {
        self.frames
            .lock()
            .unwrap()
            .iter()
            .flat_map(|frame| frame["uploaded_content"].as_array().into_iter().flatten())
            .filter_map(|value| value.as_str().map(str::to_owned))
            .collect()
    }

    /// The args of every dispatched `tab.act`, in order.
    pub(crate) fn acts(&self) -> Vec<Value> {
        self.frames
            .lock()
            .unwrap()
            .iter()
            .filter(|frame| frame["op"] == "tab.act")
            .map(|frame| frame["args"].clone())
            .collect()
    }
}

fn tab(id: &str, profile: &str, url: &str) -> Value {
    json!({"id":id,"owner":"conversation:general","profile":profile,"epoch":1,"holder":"agent","inUse":false,"url":url})
}

fn respond(op: &str, frame: &Value) -> Value {
    let tab = frame["tab"].as_str().unwrap_or("");
    let (profile, url) = if tab == "acct" {
        ("signed_in", ACCOUNT)
    } else {
        ("signed_out", PUBLIC)
    };
    let steps = frame["args"]["steps"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    match op {
        "tab.prepare" => {
            let resolved: Vec<Value> = steps.iter().map(facts).collect();
            json!({"status":"ok","tab":tab,"epoch":1,"obs":frame["args"]["observation"],"url":url,"profile":profile,"steps":resolved})
        }
        "tab.act" => {
            let receipts: Vec<Value> = steps
                .iter()
                .map(|step| json!({"status":"completed","hit":facts(step)["hit"]}))
                .collect();
            json!({"status":"ok","tab":tab,"url":url,"epoch":1,"completed":receipts.len(),"steps":receipts})
        }
        "tab.observe" => json!({"status":"ok","tab":tab,"obs":"obs-1","url":url,
            "text":"button Reject all [e1]; searchbox Search [e2]; combobox Size [e3]; link Wool coat [e4]; tab Reviews [e5]"}),
        _ => json!({"status":"ok"}),
    }
}

/// What the executor resolves for a step: role and name, and the payment,
/// upload, submit and POST-form facts of its target.
fn facts(step: &Value) -> Value {
    if step["action"] == "upload" {
        return json!({"hit":{"role":"input","name":"Upload","ref":step["ref"],"frame":"fixture"},
            "payment":false,"upload":true,"submit":false,"frame_payment":false,"form_post":false,"addons":[]});
    }
    if matches!(step["action"].as_str(), Some("type" | "press")) {
        return json!({"keyboard":true,"deferred":true,"hit":{"role":"focus","name":"","frame":""},
            "payment":false,"upload":false,"submit":false,"frame_payment":false,"addons":[]});
    }
    // A frame's host, however the page wrote it: only that says it is a payment widget.
    let framed = match step["ref"].as_str().unwrap_or("") {
        "e10" => Some("checkout.stripe.com."),
        "e11" => Some("CHECKOUT.Stripe.COM"),
        "e12" => Some("checkout.notstripe.com."),
        _ => None,
    };
    if let Some(frame) = framed {
        return json!({"hit":{"role":"button","name":"Continue","frame":frame,"ref":step["ref"]},
            "payment":false,"upload":false,"submit":false,"frame_payment":false,"form_post":false,"addons":[]});
    }
    let (role, name, payment, submit, form_post) = match step["ref"].as_str().unwrap_or("") {
        "e1" => ("button", "Reject all", false, false, false),
        "e2" => ("searchbox", "Search", false, false, false),
        "e3" => ("combobox", "Size", false, false, false),
        "e4" => ("link", "Wool coat", false, false, false),
        "e5" => ("tab", "Reviews", false, false, false),
        "e6" => ("textbox", "Comment", false, false, false),
        "e7" => ("button", "Post", false, true, true),
        "e8" => ("button", "Send", false, false, false),
        "e9" => ("button", "Pay now", true, true, false),
        other => panic!("unknown fixture ref {other}"),
    };
    json!({"hit":{"role":role,"name":name,"frame":"fixture","ref":step["ref"]},"payment":payment,
        "upload":false,"submit":submit,"frame_payment":false,"form_post":form_post,"addons":[]})
}

/// One scripted model turn per request: describe the browser tools, run each
/// call through `tool_call`, then answer.
pub(crate) fn cassette(turns: &[(String, Vec<Value>)]) -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let stub = super::super::browser_usage::stub::response;
    for (turn, (request, calls)) in turns.iter().enumerate() {
        let mut ids = vec![
            "native:browser_observe",
            "native:browser_act",
            "native:image_collect",
        ];
        for id in calls.iter().filter_map(|call| call["id"].as_str()) {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        let describe = json!({"ids":ids});
        let mut round = Vec::new();
        let mut items = vec![("tool_describe", describe)];
        items.extend(calls.iter().map(|call| ("tool_call", call.clone())));
        for (index, (name, args)) in items.into_iter().enumerate() {
            let mut exchange = template.exchanges[0].clone();
            exchange.request.key.user_request = request.clone();
            exchange.request.key.round = round.clone();
            exchange.response = stub(
                &json!({"type":"function_call","id":format!("fc_scope_{turn}_{index}"),
                "call_id":format!("call_scope_{turn}_{index}"),"name":name,"arguments":args.to_string(),"status":"completed"}),
            );
            cassette.exchanges.push(exchange);
            round.extend(["function_call".into(), "function_call_output".into()]);
        }
        let mut last = template.exchanges[1].clone();
        last.request.key.user_request = request.clone();
        last.request.key.round = round;
        last.response = stub(
            &json!({"type":"message","id":format!("msg_scope_{turn}"),"role":"assistant",
            "status":"completed","content":[{"type":"output_text","text":"Done.","annotations":[]}]}),
        );
        cassette.exchanges.push(last);
    }
    Ok(cassette)
}

/// A `tool_call` of `name` with `arguments`.
pub(crate) fn call(name: &str, arguments: Value) -> Value {
    let mut call = json!({ "id": format!("native:{name}") });
    call["arguments"] = arguments;
    call
}
