//! Parallel tabs in the page executor (headless or hidden App): four pages
//! opened and observed at once, each rendering in the background (timers,
//! animation frames, lazy content, a screenshot), three independent actions
//! at once, page events of one conversation's parallel turns kept apart, and
//! other conversations browsing alongside.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::support::{admin, call, node, open, publish_as, selected, setup};
use super::text;
use butler_e2e::e2e::{HarnessError, security::AdminClient};
use futures_util::future::join_all;
use reqwest::Method;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const ME: &str = "general";

/// Shop page `n`: its price, a cart button, a pop-up button, and facts the
/// page records only while it runs: a timer, animation frames, a lazy block
/// shown by an IntersectionObserver, and its visibility.
fn page(n: usize) -> String {
    format!(
        r#"<!doctype html><meta charset="utf-8"><title>Shop {n}</title>
<style>body{{font:18px system-ui;margin:0;padding:24px}}button{{font:inherit;margin:8px;padding:8px 16px}}p{{margin:6px}}</style>
<main><h1>Item {n}</h1><p>Price {n},000 won</p>
<p id="timer">Timer waiting</p><p id="frames">Frames waiting</p><p id="lazy">Lazy waiting</p><p id="vis">Visibility unknown</p>
<button onclick="document.querySelector('#cart').textContent='Added to cart {n}'">Add to cart</button><p id="cart">Cart empty</p>
<button onclick="setTimeout(()=>window.open('./popup.html','_blank'),1500)">Open popup</button></main>
<script>
const set=(id,value)=>document.getElementById(id).textContent=value;
let ticks=0;const timer=setInterval(()=>{{if(++ticks===5){{clearInterval(timer);set('timer','Timer fired 5')}}}},20);
let frames=0;const frame=()=>{{if(++frames===5)set('frames','Frames painted 5');else requestAnimationFrame(frame)}};requestAnimationFrame(frame);
new IntersectionObserver(seen=>{{if(seen.some(e=>e.isIntersecting))set('lazy','Lazy loaded {n}')}}).observe(document.getElementById('lazy'));
const vis=()=>set('vis','Visibility '+document.visibilityState);vis();document.addEventListener('visibilitychange',vis);
</script>"#
    )
}

/// A dense product grid: over 16 KB of controls on one screen, which a
/// default observation carries whole.
fn long_page() -> String {
    let links = (1..=300)
        .map(|n| format!("<a href=\"#p{n}\">Field jacket colour variant {n}</a>"))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Grid</title><style>body{{margin:0;font:6px system-ui;line-height:7px}}</style><main>{links}<a href=\"#end\">End of grid</a></main>"
    )
}

const POPUP: &str =
    r#"<!doctype html><meta charset="utf-8"><title>Popup</title><main><h1>Popup page</h1></main>"#;

/// The publishing turn's calls: four shop pages and the pop-up page.
pub(super) fn publish_calls() -> Vec<(&'static str, Value)> {
    let mut calls: Vec<(&'static str, Value)> = (1..=4)
        .map(|n| {
            (
                "write_file",
                json!({"path":format!("parallel-site/page-{n}.html"),"content":page(n),"create_parents":true}),
            )
        })
        .collect();
    calls.push((
        "write_file",
        json!({"path":"parallel-site/popup.html","content":POPUP,"create_parents":true}),
    ));
    calls.push((
        "write_file",
        json!({"path":"parallel-site/long.html","content":long_page(),"create_parents":true}),
    ));
    calls.push((
        "write_file",
        json!({"path":"parallel-site/index.html","content":"<!doctype html><title>Shops</title>","create_parents":true}),
    ));
    calls.push((
        "output_publish",
        json!({"path":"parallel-site","title":"Parallel fixture"}),
    ));
    calls
}

/// One call on behalf of `turn` (a turn of the conversation, or a delegated
/// child's turn: they share the conversation's tabs).
async fn call_as(
    admin: &AdminClient,
    session: &str,
    turn: &str,
    (op, tab): (&str, &Value),
    args: Value,
) -> Result<Value, HarnessError> {
    let reply = admin
        .send(
            Method::POST,
            "/internal/browser/calls",
            Some(json!({"op":op,"session":session,"tab":tab,"args":args,"turn_id":turn})),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 200, "{op}: {}", reply.text);
    Ok(reply.body)
}

const RUNNING: [&str; 4] = [
    "Timer fired 5",
    "Frames painted 5",
    "Lazy loaded",
    "Visibility visible",
];

/// An observation with pixels once the background page has run its timer,
/// frames and lazy block (re-observed while they are still pending).
async fn observe_running(
    admin: &AdminClient,
    turn: &str,
    tab: &Value,
) -> Result<(Value, usize), HarnessError> {
    let args = json!({"include_image":true,"settle":true});
    let mut observed = call_as(admin, ME, turn, ("tab.observe", tab), args.clone()).await?;
    let mut attempts = 1;
    while attempts < 10 && !RUNNING.iter().all(|fact| text(&observed).contains(fact)) {
        tokio::time::sleep(Duration::from_millis(200)).await;
        observed = call_as(admin, ME, turn, ("tab.observe", tab), args.clone()).await?;
        attempts += 1;
    }
    Ok((observed, attempts))
}

/// Clicks the named button and returns the settled observation.
async fn click(
    admin: &AdminClient,
    turn: &str,
    tab: &Value,
    from: &Value,
    name: &str,
) -> Result<Value, HarnessError> {
    let steps = json!([{"action":"click","ref":node(from, "button", name)["ref"]}]);
    let args = json!({"observation":from["obs"],"steps":steps});
    let prepared = call_as(admin, ME, turn, ("tab.prepare", tab), args).await?;
    assert_eq!(prepared["status"], "ok", "{prepared}");
    let args = json!({"observation":from["obs"],"steps":steps,"prepared_steps":prepared["steps"]});
    let acted = call_as(admin, ME, turn, ("tab.act", tab), args).await?;
    assert_eq!(acted["steps"][0]["status"], "completed", "{acted}");
    Ok(acted)
}

#[tokio::test]
async fn headless_parallel_tabs_render_act_and_route_events() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(selected(), "BUTLER_E2E_BROWSER_BACKEND=headless not set");
    let s = setup("BROWSER-HEADLESS-PARALLEL")?.start().await?;
    let admin = admin(&s);
    let base = url::Url::parse(&publish_as(&s, "Publish parallel").await?.1).unwrap();
    let url = |n: usize| base.join(&format!("page-{n}.html")).unwrap().to_string();
    let warm = open(&admin, "warmup", &url(1)).await?;
    assert_eq!(warm["status"], "ok", "{warm}");
    call_as(
        &admin,
        "warmup",
        "w",
        ("tab.close", &warm["tab"]),
        json!({}),
    )
    .await?;

    // One page after another: open, then observe.
    let started = Instant::now();
    for n in 1..=4 {
        let opened = call_as(
            &admin,
            ME,
            "serial",
            ("tab.open", &Value::Null),
            json!({"url":url(n)}),
        )
        .await?;
        assert_eq!(opened["status"], "ok", "{opened}");
        let (observed, _) = observe_running(&admin, "serial", &opened["tab"]).await?;
        assert_eq!(observed["status"], "ok", "{observed}");
        call_as(
            &admin,
            ME,
            "serial",
            ("tab.close", &opened["tab"]),
            json!({}),
        )
        .await?;
    }
    let serial_ms = started.elapsed().as_millis();

    // All four at once: one round opens them, the next observes them.
    let started = Instant::now();
    let opened = join_all((1..=4).map(|n| {
        call_as(
            &admin,
            ME,
            "turn-a",
            ("tab.open", &Value::Null),
            json!({"url":url(n)}),
        )
    }))
    .await;
    let tabs: Vec<Value> = opened
        .into_iter()
        .map(|opened| {
            let opened = opened.unwrap();
            assert_eq!(opened["status"], "ok", "every tab opens: {opened}");
            opened["tab"].clone()
        })
        .collect();
    let observed = join_all(
        tabs.iter()
            .map(|tab| observe_running(&admin, "turn-a", tab)),
    )
    .await;
    let parallel_ms = started.elapsed().as_millis();
    let mut attempts = Vec::new();
    let mut views = Vec::new();
    for (n, result) in (1..=4).zip(observed) {
        let (view, tries) = result?;
        let page = text(&view);
        assert!(page.contains(&format!("Price {n},000 won")), "{page}");
        for fact in RUNNING {
            assert!(
                page.contains(fact),
                "background tab {n} runs ({fact}): {page}"
            );
        }
        let pixels = view["image"]["data"].as_str().map_or(0, str::len);
        assert!(pixels > 1000, "background tab {n} has pixels: {view}");
        attempts.push(tries);
        views.push(view);
    }

    // Three independent actions at once.
    let acted =
        join_all((0..3).map(|i| click(&admin, "turn-a", &tabs[i], &views[i], "Add to cart"))).await;
    for (i, acted) in acted.into_iter().enumerate() {
        acted?;
        let (after, _) = observe_running(&admin, "turn-a", &tabs[i]).await?;
        assert!(
            text(&after).contains(&format!("Added to cart {}", i + 1)),
            "{after}"
        );
        views[i] = after;
    }
    route_events(&admin, &tabs, &views).await?;

    // Other conversations browse while this one holds its tabs.
    let others = join_all(["other-1", "other-2"].map(|session| {
        call_as(
            &admin,
            session,
            "turn-o",
            ("tab.open", &Value::Null),
            json!({"url":url(4)}),
        )
    }))
    .await;
    for other in others {
        let other = other?;
        assert_eq!(other["status"], "ok", "another conversation opens: {other}");
    }
    eprintln!(
        "headless-parallel serial_ms={serial_ms} parallel_ms={parallel_ms} observe_attempts={attempts:?}"
    );
    s.finish().await
}

/// A pop-up event of turn A's tab reaches turn A's calls, never turn B's,
/// though both turns drive tabs of the same conversation.
async fn route_events(
    admin: &AdminClient,
    tabs: &[Value],
    views: &[Value],
) -> Result<(), HarnessError> {
    observe_running(admin, "turn-b", &tabs[3]).await?;
    // The page opens its pop-up a moment after the click, while turn B calls.
    let acted = click(admin, "turn-a", &tabs[0], &views[0], "Open popup").await?;
    assert!(!acted.to_string().contains("popup_opened"), "{acted}");
    let mut opened = None;
    for _ in 0..30 {
        let other = call_as(
            admin,
            ME,
            "turn-b",
            ("tab.observe", &tabs[3]),
            json!({"look":"never"}),
        )
        .await?;
        assert!(
            !other.to_string().contains("popup_opened"),
            "turn B never takes turn A's events: {other}"
        );
        let own = call_as(admin, ME, "turn-a", ("tabs.list", &Value::Null), json!({})).await?;
        if let Some(event) = own["events"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|e| e["type"] == "popup_opened")
        {
            assert_eq!(event["tab"], tabs[0], "{event}");
            assert!(
                event.get("turn").is_none(),
                "routing stays internal: {event}"
            );
            opened = Some(event["popup"].clone());
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let popup = opened.expect("turn A receives its popup_opened event");
    call_as(admin, ME, "turn-a", ("tab.close", &popup), json!({})).await?;
    Ok(())
}

/// Agent tabs the browser holds on this machine: one per GiB, 6 to 24.
fn agent_tabs() -> usize {
    let gib = butler_platform::memory::total_bytes() >> 30;
    usize::try_from(gib).unwrap_or(24).clamp(6, 24)
}

/// With every agent tab open, a new tab still opens: the least recently used
/// idle tab (of any conversation) closes to make room, never one in use.
#[tokio::test]
async fn headless_full_browser_closes_idle_tab_for_new_one() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(selected(), "BUTLER_E2E_BROWSER_BACKEND=headless not set");
    let s = setup("BROWSER-HEADLESS-ROOM")?.start().await?;
    let admin = admin(&s);
    let base = url::Url::parse(&publish_as(&s, "Publish parallel").await?.1).unwrap();
    let url = base.join("page-1.html").unwrap().to_string();
    let mut filled = Vec::new();
    for _ in 0..agent_tabs() {
        let opened = open(&admin, "filler", &url).await?;
        assert_eq!(opened["status"], "ok", "{opened}");
        filled.push(opened["tab"].clone());
    }
    let args = json!({"url":url});
    let fresh = call_as(&admin, ME, "fresh", ("tab.open", &Value::Null), args).await?;
    assert_eq!(fresh["status"], "ok", "a full browser still opens: {fresh}");
    let left = call(&admin, "filler", "tabs.list", &Value::Null, json!({})).await?;
    let left: Vec<&Value> = left["tabs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| &t["id"])
        .collect();
    assert_eq!(left.len(), filled.len() - 1, "{left:?}");
    assert!(
        !left.contains(&&filled[0]),
        "the least recently used tab closed: {left:?}"
    );
    // A default observation over 16 KB (a dense grid of controls) is returned whole.
    let long = base.join("long.html").unwrap().to_string();
    let opened = call_as(
        &admin,
        ME,
        "fresh",
        ("tab.open", &Value::Null),
        json!({"url":long}),
    )
    .await?;
    let args = json!({"settle":true,"look":"never"});
    let read = call_as(&admin, ME, "fresh", ("tab.observe", &opened["tab"]), args).await?;
    assert_eq!(read["status"], "ok", "{read}");
    assert!(text(&read).len() > 16_000, "{}", text(&read).len());
    assert!(text(&read).contains("End of grid"), "{read}");
    s.finish().await
}
