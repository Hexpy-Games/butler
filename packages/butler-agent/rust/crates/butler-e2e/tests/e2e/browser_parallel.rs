//! Parallel tabs: one model round opens or observes several pages at once
//! and the next acts on each of them, and the gateway runs every call of a
//! burst (queueing past its slots, never refusing). A fake App host answers
//! each page call after a fixed latency, so the parallel and one-by-one runs
//! of the same work compare by wall time.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::browser_speed::{outputs, response};
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup, security::AdminClient};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

/// Every fake page call takes this long.
const HOST_DELAY: Duration = Duration::from_millis(300);

type Round = Vec<(&'static str, Value)>;

fn site(n: usize) -> String {
    format!("https://shop-{n}.example/item")
}

/// "Research the same item on 4 sites and compare": all opens in one round,
/// all observations in the next; or one call per round.
fn research(parallel: bool) -> Vec<Round> {
    let open = |n| ("browser_open", json!({"url":site(n)}));
    let observe = |n| ("browser_observe", json!({"tab":format!("s{n}")}));
    if parallel {
        return vec![(1..=4).map(open).collect(), (1..=4).map(observe).collect()];
    }
    (1..=4)
        .flat_map(|n| [vec![open(n)], vec![observe(n)]])
        .collect()
}

/// "Do one independent action on each of 3 pages": open, observe and act on
/// the three side by side; or each page through in turn.
fn actions(parallel: bool) -> Vec<Round> {
    let open = |n| ("browser_open", json!({"url":site(n)}));
    let observe = |n| ("browser_observe", json!({"tab":format!("s{n}")}));
    let act = |n| {
        (
            "browser_act",
            json!({"tab":format!("s{n}"),"observation":format!("s{n}-1"),"observe":true,
                "steps":[{"action":"click","ref":"f0-e1"}]}),
        )
    };
    if parallel {
        return vec![
            (1..=3).map(open).collect(),
            (1..=3).map(observe).collect(),
            (1..=3).map(act).collect(),
        ];
    }
    (1..=3)
        .flat_map(|n| [vec![open(n)], vec![observe(n)], vec![act(n)]])
        .collect()
}

struct Run {
    rounds: usize,
    peak: usize,
    turn_ms: u128,
    largest_request: usize,
    last: Vec<Value>,
    all: Vec<Value>,
}

async fn run(id: &str, request: &str, script: Vec<Round>) -> Result<Run, HarnessError> {
    let s = Setup::new(id)?
        .stub_cassette(cassette(request, &script)?)
        .start()
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let host = Host::attach(admin).await?;
    let serving = tokio::spawn(host.serve(None));
    let started = Instant::now();
    s.turn("general", request).await?;
    let turn_ms = started.elapsed().as_millis();
    let peak = tokio::time::timeout(Duration::from_secs(30), serving)
        .await
        .unwrap()
        .unwrap()?;
    let requests = s.provider()?.requests();
    let all = requests.iter().skip(1).flat_map(outputs).collect();
    let run = Run {
        rounds: requests.len(),
        peak,
        turn_ms,
        largest_request: requests.iter().map(|r| r.to_string().len()).max().unwrap(),
        last: outputs(requests.last().unwrap()),
        all,
    };
    s.finish().await?;
    Ok(run)
}

fn report(shape: &str, parallel: &Run, serial: &Run) {
    eprintln!(
        "browser-parallel shape={shape} parallel_rounds={} parallel_peak={} parallel_ms={} \
         serial_rounds={} serial_peak={} serial_ms={} largest_request_bytes={}",
        parallel.rounds,
        parallel.peak,
        parallel.turn_ms,
        serial.rounds,
        serial.peak,
        serial.turn_ms,
        parallel.largest_request
    );
}

fn assert_complete(run: &Run) {
    for output in &run.all {
        assert_ne!(output["ok"], false, "{output}");
        let status = &output["output"]["status"];
        assert!(status == "ok" || status.is_null(), "{output}");
    }
}

#[tokio::test]
async fn browser_parallel_research_four_sites() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let request = "Compare the item on four shops";
    let parallel = run("BROWSER-PARALLEL-RESEARCH", request, research(true)).await?;
    let serial = run("BROWSER-SERIAL-RESEARCH", request, research(false)).await?;
    report("research-4", &parallel, &serial);
    assert_complete(&parallel);
    assert_complete(&serial);
    assert_eq!(parallel.rounds, 3, "open all, observe all, answer");
    assert_eq!(parallel.peak, 4, "four tabs in flight at once");
    assert_eq!(serial.peak, 1);
    // Every page's observation reaches the model whole, pixels included.
    let observed = &parallel.last;
    assert_eq!(observed.len(), 4, "{observed:?}");
    for (n, output) in observed.iter().enumerate() {
        let page = output.to_string();
        assert!(page.contains(&format!("Price {},000 won", n + 1)), "{page}");
    }
    assert!(parallel.turn_ms < serial.turn_ms, "parallel is faster");
    Ok(())
}

#[tokio::test]
async fn browser_parallel_actions_three_pages() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let request = "Add the item on three shops";
    let parallel = run("BROWSER-PARALLEL-ACTIONS", request, actions(true)).await?;
    let serial = run("BROWSER-SERIAL-ACTIONS", request, actions(false)).await?;
    report("actions-3", &parallel, &serial);
    assert_complete(&parallel);
    assert_complete(&serial);
    assert_eq!(parallel.rounds, 4, "open, observe, act on all; answer");
    assert_eq!(parallel.peak, 3);
    let acted = &parallel.last;
    assert_eq!(acted.len(), 3, "{acted:?}");
    for output in acted {
        assert!(output.to_string().contains("Added to cart"), "{output}");
    }
    assert!(parallel.turn_ms < serial.turn_ms, "parallel is faster");
    Ok(())
}

/// More page calls at once than the gateway has slots (and than its old fixed
/// limit of 8): every one runs and answers; the excess waits its turn.
#[tokio::test]
async fn browser_parallel_burst_queues_instead_of_refusing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    const BURST: usize = 36;
    let s = Setup::new("BROWSER-PARALLEL-BURST")?.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let host = Host::attach(admin.clone()).await?;
    let tabs: Vec<String> = (1..=BURST).map(|n| format!("s{n}")).collect();
    host.publish(&tabs).await?;
    let serving = tokio::spawn(host.serve(Some(BURST)));
    let started = Instant::now();
    let calls = tabs.iter().map(|tab| {
        let admin = admin.clone();
        async move {
            admin
                .send(
                    Method::POST,
                    "/internal/browser/calls",
                    Some(json!({"op":"tab.observe","session":"general","tab":tab,"args":{"look":"never"}})),
                    &[],
                )
                .await
        }
    });
    let replies = futures_util::future::join_all(calls).await;
    let burst_ms = started.elapsed().as_millis();
    for (tab, reply) in tabs.iter().zip(replies) {
        let reply = reply?;
        assert_eq!(reply.status, 200, "{tab}: {}", reply.text);
        assert_eq!(reply.body["status"], "ok", "{tab}: {}", reply.text);
        assert_eq!(reply.body["tab"], tab.as_str());
    }
    let peak = tokio::time::timeout(Duration::from_secs(30), serving)
        .await
        .unwrap()
        .unwrap()?;
    eprintln!("browser-parallel shape=burst calls={BURST} peak={peak} ms={burst_ms}");
    assert!((8..=32).contains(&peak), "slots bound the burst: {peak}");
    s.finish().await
}

/// A fake App host on the gateway's browser-host channel.
struct Host {
    stream: reqwest::Response,
    admin: AdminClient,
    pages: Arc<Mutex<BTreeMap<String, usize>>>,
}

impl Host {
    async fn attach(admin: AdminClient) -> Result<Self, HarnessError> {
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
            pages: Arc::default(),
        })
    }

    /// Reports the open tabs, as the App does after every change.
    async fn publish(&self, tabs: &[String]) -> Result<(), HarnessError> {
        Self::publish_tabs(&self.admin, tabs).await
    }

    /// Answers page calls until the turn finishes (or `limit` calls); returns
    /// the most page calls that were in flight at once.
    async fn serve(mut self, limit: Option<usize>) -> Result<usize, HarnessError> {
        let mut buffer = String::new();
        let (live, peak) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let host = Arc::new(Opened {
            admin: self.admin.clone(),
            tabs: tokio::sync::Mutex::default(),
            pages: self.pages.clone(),
        });
        let mut calls = Vec::new();
        while limit.is_none_or(|limit| calls.len() < limit) {
            let frame =
                super::browser_delegation::next_frame(&mut self.stream, &mut buffer).await?;
            match frame["op"].as_str().unwrap() {
                "use.started" | "use.ended" => continue,
                "use.finished" => break,
                _ => (),
            }
            let (live, peak, host) = (live.clone(), peak.clone(), host.clone());
            calls.push(tokio::spawn(async move {
                let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(HOST_DELAY).await;
                live.fetch_sub(1, Ordering::SeqCst);
                host.answer(&frame).await
            }));
        }
        for call in calls {
            call.await.unwrap()?;
        }
        Ok(peak.load(Ordering::SeqCst))
    }
}

/// The fake App's tabs: `s<n>` shows shop n's item page.
struct Opened {
    admin: AdminClient,
    tabs: tokio::sync::Mutex<Vec<String>>,
    pages: Arc<Mutex<BTreeMap<String, usize>>>,
}

impl Opened {
    async fn answer(&self, frame: &Value) -> Result<(), HarnessError> {
        let tab = frame["tab"].as_str().unwrap_or_default().to_owned();
        let result = match frame["op"].as_str().unwrap() {
            "tab.waiting" => json!({"status":"ok"}),
            "tab.open" => {
                let url = frame["args"]["url"].as_str().unwrap();
                let n = url
                    .trim_start_matches("https://shop-")
                    .split('.')
                    .next()
                    .unwrap();
                let tab = format!("s{n}");
                // Snapshots go out in order, as the App's one flush chain sends them.
                let mut tabs = self.tabs.lock().await;
                tabs.push(tab.clone());
                Host::publish_tabs(&self.admin, &tabs).await?;
                drop(tabs);
                json!({"status":"ok","tab":tab,"url":url,"epoch":1,"profile":"signed_out"})
            }
            "tab.observe" => self.observe(&tab),
            "tab.prepare" => {
                json!({"status":"ok","tab":tab,"url":site(tab[1..].parse().unwrap()),"steps":[{"hit":{"role":"button","name":"Add to cart","frame":""}}]})
            }
            "tab.act" => {
                self.pages.lock().unwrap().insert(format!("{tab}:added"), 1);
                json!({"status":"ok","tab":tab,"completed":1,"steps":[{"status":"completed","hit":{"role":"button","name":"Add to cart"}}]})
            }
            op => panic!("unexpected browser op {op}"),
        };
        let path = format!(
            "/internal/browser-host/results/{}",
            frame["id"].as_str().unwrap()
        );
        let response = self
            .admin
            .send(Method::POST, &path, Some(result), &[])
            .await?;
        assert_eq!(response.status, 200, "{}", response.text);
        Ok(())
    }

    fn observe(&self, tab: &str) -> Value {
        let n: usize = tab[1..].parse().unwrap();
        let mut pages = self.pages.lock().unwrap();
        let added = pages.contains_key(&format!("{tab}:added"));
        let count = pages.entry(tab.to_owned()).or_default();
        *count += 1;
        let text = if added {
            format!("heading \"Item {n}\" [f0-e2]\nAdded to cart\nPrice {n},000 won")
        } else {
            format!(
                "heading \"Item {n}\" [f0-e2]\nPrice {n},000 won\nbutton \"Add to cart\" [f0-e1]"
            )
        };
        let pixels = STANDARD.encode(include_bytes!(
            "../../fixtures/browser-route/observation.jpg"
        ));
        json!({"status":"ok","tab":tab,"obs":format!("{tab}-{count}"),"url":site(n),"text":text,
            "image_geometry":{"width":1024,"height":640,"cssWidth":1280,"cssHeight":800},"image":{"mime_type":"image/jpeg","data":pixels}})
    }
}

impl Host {
    async fn publish_tabs(admin: &AdminClient, tabs: &[String]) -> Result<(), HarnessError> {
        let tabs: Vec<Value> = tabs.iter().map(|id| json!({"id":id,"owner":"conversation:general","profile":"signed_out","epoch":1,"holder":"agent","url":site(id[1..].parse().unwrap())})).collect();
        let sent = admin
            .send(
                Method::POST,
                "/internal/browser-host/events",
                Some(json!({"tabs":tabs})),
                &[],
            )
            .await?;
        assert_eq!(sent.status, 200, "{}", sent.text);
        Ok(())
    }
}

fn cassette(request: &str, script: &[Round]) -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let mut round: Vec<String> = Vec::new();
    for (index, calls) in script.iter().enumerate() {
        let mut exchange = template.exchanges[0].clone();
        exchange.request.key.user_request = request.into();
        exchange.request.key.round = round.clone();
        let items: Vec<Value> = calls
            .iter()
            .enumerate()
            .map(|(n, (name, args))| json!({"type":"function_call","id":format!("fc_par_{index}_{n}"),"call_id":format!("call_par_{index}_{n}"),"name":name,"arguments":args.to_string(),"status":"completed"}))
            .collect();
        exchange.response = response(&items);
        cassette.exchanges.push(exchange);
        round.extend(calls.iter().map(|_| "function_call".to_owned()));
        round.extend(calls.iter().map(|_| "function_call_output".to_owned()));
    }
    let mut done = template.exchanges[1].clone();
    done.request.key.user_request = request.into();
    done.request.key.round = round;
    done.response = response(&[
        json!({"type":"message","id":"msg_par","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Done.","annotations":[]}]}),
    ]);
    cassette.exchanges.push(done);
    Ok(cassette)
}
