//! A scripted browser host for DevTools reads: each tab has a live page and
//! answers reads with raw data, credentials included, as a host could report
//! it. Whatever reaches the model has to have come through the masking.
use butler_e2e::e2e::{HarnessError, scenario::Scenario, security::AdminClient};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

pub(super) const SECRETS: &[&str] = &[
    "SECRET-COOKIE",
    "SECRET-SET-COOKIE",
    "SECRET-AUTH",
    "SECRET-BODY-REQUEST",
    "SECRET-BODY-RESPONSE",
    "SECRET-QUERY",
    "SECRET-PASSWORD",
    "SECRET-CSRF",
    "SECRET-CONSOLE",
    "SECRET-CARD",
    "SECRET-CODE",
    "SECRET-KEY",
    "eyJSECRET",
];

#[derive(Clone, Default)]
struct Pages(Arc<Mutex<BTreeMap<String, Value>>>);

impl Pages {
    fn page(&self, tab: &str) -> Value {
        self.0.lock().unwrap().get(tab).cloned().unwrap_or_default()
    }
}

pub(crate) struct Host {
    pages: Pages,
    admin: AdminClient,
    frames: Arc<Mutex<Vec<Value>>>,
    during_read: Arc<Mutex<Option<(String, Value)>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Host {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn snapshot(id: &str, page: &Value) -> Value {
    json!({"id":id,"owner":"conversation:general","profile":page["profile"],"epoch":1,
        "holder":"agent","inUse":false,"url":page["url"]})
}

fn raw_rows() -> Value {
    json!([{"method":"POST","url":"https://api.example.test/v1/save?q=SECRET-QUERY&access_token=SECRET-AUTH",
        "type":"XHR","status":500,"mime":"application/json","bytes":120,"ms":40,
        "cookies":"sid=SECRET-COOKIE","request_headers":{"Cookie":"sid=SECRET-COOKIE","Authorization":"Bearer SECRET-AUTH"},
        "request_body":"password=SECRET-BODY-REQUEST","response_body":"SECRET-BODY-RESPONSE",
        "response_headers":{"Set-Cookie":"sid=SECRET-SET-COOKIE; HttpOnly","Authorization":"Bearer SECRET-AUTH",
            "X-CSRF-Token":"SECRET-CSRF","Content-Type":"application/json"}},
        {"method":"GET","url":"https://user:SECRET-AUTH@cdn.example.test/a.js?v=1#id_token=SECRET-AUTH","type":"Script","status":200},
        {"method":"GET","url":"https://app.example.test/r/abcdefghijklmnopqrstuvwx1234?q=coat#top","type":"Document","status":200},
        {"method":"POST","url":"https://checkout.stripe.com/pay/SECRET-CARD?x=1","type":"Fetch","status":402,"error":"token=SECRET-CONSOLE rejected"}])
}

fn raw_nodes() -> Value {
    json!([{"d":0,"t":"form","a":[["action","/login?token=SECRET-AUTH"]]},
        {"d":1,"t":"input","a":[["type","password"],["name","pw"],["value","SECRET-PASSWORD"]]},
        {"d":1,"t":"input","a":[["type","hidden"],["name","csrf"],["value","SECRET-CSRF"]]},
        {"d":1,"t":"meta","a":[["name","csrf-token"],["content","SECRET-CSRF"]]},
        {"d":1,"t":"input","a":[["autocomplete","one-time-code"],["value","SECRET-CODE"]]},
        {"d":1,"t":"input","a":[["type","text"],["name","nick"],["value","plain-nick"]]},
        {"d":1,"t":"div","a":[["data-api-key","SECRET-KEY"],["data-user","plain-user"],["class","card"]]},
        {"d":1,"t":"a","a":[["href","./save?token=SECRET-AUTH&q=1"]]},
        {"d":1,"t":"a","a":[["href","javascript:send('SECRET-AUTH')"]]},
        {"d":1,"t":"iframe","a":[["srcdoc","<b>SECRET-AUTH</b>"]]},
        {"d":1,"t":"script","a":[],"hidden_chars":40},
        {"d":1,"t":"button","a":[["onclick","send('SECRET-AUTH')"]]},
        {"d":2,"x":"Sign in"}])
}

fn read_reply(tab: &str, page: &Value, read: &str) -> Value {
    let mut reply = json!({"status":"ok","tab":tab,"url":page["url"],"profile":page["profile"],
        "credentialed_hosts":page["credentialed_hosts"],"read":read,"dropped":0,"from_load":true});
    match read {
        "console" => {
            reply["entries"] = json!([{"level":"error",
                "text":"Failed: token=SECRET-CONSOLE at https://api.example.test/x?session=SECRET-QUERY",
                "source":"https://www.example.test/app.js?key=SECRET-AUTH","line":3},
                {"level":"error","text":"401 Bearer SECRET-AUTH cookie: sid=SECRET-COOKIE; x=2"},
                {"level":"error","text":"bad eyJSECRETjwt.eyJSECRETjwt2.sig see http://[bad","source":"javascript:send('SECRET-AUTH')","line":1}]);
        }
        "network" => reply["entries"] = raw_rows(),
        "dom" => {
            reply["nodes"] = raw_nodes();
            reply["walked_all"] = json!(true);
            reply["selector_matched"] = json!(true);
            reply["total_elements"] = json!(5);
        }
        _ => {}
    }
    reply
}

impl Host {
    pub(crate) async fn attach(
        s: &Scenario,
        tabs: &[(&str, &str, &str)],
        granted: Option<&str>,
    ) -> Result<Self, HarnessError> {
        let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
        let mut stream = reqwest::Client::new()
            .get(format!("{}/internal/browser-host", s.gw.base))
            .bearer_auth(&s.gw.token)
            .header("x-butler-admin", &admin.admin)
            .send()
            .await?;
        assert_eq!(stream.status(), 200);
        let pages = Pages::default();
        for (id, profile, url) in tabs {
            pages.0.lock().unwrap().insert(
                (*id).to_owned(),
                json!({"url":url,"profile":profile,"credentialed_hosts":[]}),
            );
        }
        let frames = Arc::new(Mutex::new(Vec::new()));
        let during_read = Arc::new(Mutex::new(None::<(String, Value)>));
        let replying = admin.clone();
        let (seen, moved, live) = (frames.clone(), during_read.clone(), pages.clone());
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
                seen.lock().unwrap().push(frame.clone());
                let tab = frame["tab"].as_str().unwrap_or("");
                if op == "tab.devtools"
                    && let Some((target, page)) = moved.lock().unwrap().take()
                {
                    live.0.lock().unwrap().insert(target, page);
                }
                let page = live.page(tab);
                let reply = match op.as_str() {
                    "tab.devtools_place" => json!({"status":"ok","tab":tab,"url":page["url"],
                        "profile":page["profile"],"credentialed_hosts":page["credentialed_hosts"]}),
                    "tab.devtools" => {
                        read_reply(tab, &page, frame["args"]["read"].as_str().unwrap_or(""))
                    }
                    _ => json!({"status":"ok"}),
                };
                let id = frame["id"].as_str().unwrap_or("");
                let _ = replying
                    .send(
                        Method::POST,
                        &format!("/internal/browser-host/results/{id}"),
                        Some(reply),
                        &[],
                    )
                    .await;
            }
        });
        let host = Self {
            pages,
            admin,
            frames,
            during_read,
            task,
        };
        host.publish().await?;
        if let Some(site) = granted {
            let grant =
                json!({"op":"signin.grant","session":"general","tab":"","args":{"site":site}});
            let reply = host
                .admin
                .send(Method::POST, "/internal/browser/calls", Some(grant), &[])
                .await?;
            assert_eq!(reply.status, 200, "{}", reply.text);
        }
        Ok(host)
    }

    async fn publish(&self) -> Result<(), HarnessError> {
        let tabs: Vec<Value> = self
            .pages
            .0
            .lock()
            .unwrap()
            .iter()
            .map(|(id, page)| snapshot(id, page))
            .collect();
        let reply = self
            .admin
            .send(
                Method::POST,
                "/internal/browser-host/events",
                Some(json!({ "tabs": tabs })),
                &[],
            )
            .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        Ok(())
    }

    /// The tab commits another page.
    pub(crate) async fn navigate(&self, tab: &str, url: &str) -> Result<(), HarnessError> {
        if let Some(page) = self.pages.0.lock().unwrap().get_mut(tab) {
            page["url"] = json!(url);
        }
        self.publish().await
    }

    /// The next read finds the tab on `url`, as if it moved after the place check.
    pub(crate) fn moves_during_read(&self, tab: &str, url: &str, credentialed: &[&str]) {
        let mut page = self.pages.page(tab);
        page["url"] = json!(url);
        page["credentialed_hosts"] = json!(credentialed);
        *self.during_read.lock().unwrap() = Some((tab.to_owned(), page));
    }

    /// The args of every dispatched read, in order.
    pub(crate) fn reads(&self) -> Vec<Value> {
        self.frames
            .lock()
            .unwrap()
            .iter()
            .filter(|frame| frame["op"] == "tab.devtools")
            .map(|frame| frame["args"].clone())
            .collect()
    }

    pub(crate) fn frames_text(&self) -> String {
        Value::Array(self.frames.lock().unwrap().clone()).to_string()
    }
}
