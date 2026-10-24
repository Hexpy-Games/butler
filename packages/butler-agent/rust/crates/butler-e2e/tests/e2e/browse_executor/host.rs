use super::*;
use butler_e2e::e2e::scenario::Scenario;
use reqwest::Method;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

pub(super) async fn start(
    s: &Scenario,
) -> Result<
    (
        tokio::task::JoinHandle<Result<(), HarnessError>>,
        Arc<AtomicUsize>,
    ),
    HarnessError,
> {
    start_with_failures(s, 0).await
}

pub(super) async fn start_with_failures(
    s: &Scenario,
    failures: usize,
) -> Result<
    (
        tokio::task::JoinHandle<Result<(), HarnessError>>,
        Arc<AtomicUsize>,
    ),
    HarnessError,
> {
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    let actions = Arc::new(AtomicUsize::new(0));
    let task = tokio::spawn(serve(stream, admin, actions.clone(), failures));
    Ok((task, actions))
}

async fn serve(
    mut stream: reqwest::Response,
    admin: AdminClient,
    actions: Arc<AtomicUsize>,
    mut failures: usize,
) -> Result<(), HarnessError> {
    let mut buffer = String::new();
    let mut tabs = std::collections::BTreeMap::new();
    let mut observed = std::collections::BTreeMap::<String, usize>::new();
    while let Some(frame) = crate::browser_prefix::next_frame(&mut stream, &mut buffer).await? {
        let tab = frame["tab"].as_str().unwrap_or("");
        let result = match frame["op"].as_str().unwrap() {
            "use.started" | "use.ended" | "use.finished" => continue,
            "tab.waiting" => json!({"status":"ok"}),
            "tab.open" => {
                let url = frame["args"]["url"].as_str().unwrap();
                let id = url.rsplit('/').next().unwrap();
                tabs.insert(id.to_owned(), json!({"id":id,"owner":"conversation:general","profile":"signed_out","epoch":1,"holder":"agent","inUse":false,"url":url}));
                admin
                    .send(
                        Method::POST,
                        "/internal/browser-host/events",
                        Some(json!({"tabs":tabs.values().collect::<Vec<_>>()})),
                        &[],
                    )
                    .await?;
                json!({"status":"ok","tab":id,"url":url})
            }
            "tab.observe" => {
                let index = observed.entry(tab.to_owned()).or_default();
                *index += 1;
                let current = tabs[tab]["url"]
                    .as_str()
                    .unwrap()
                    .rsplit('/')
                    .next()
                    .unwrap();
                let page = match current {
                    "listing" => "Earlier listing",
                    "product-a" => "First product: Aster desk lamp. Price 18",
                    "cart" => "Cart: Birch desk lamp in cart",
                    "checkout" => "Checkout: Birch desk lamp in cart",
                    _ => "Latest product: Birch desk lamp",
                };
                let raw = crate::browser_observation_v2::fixture("product");
                let button = if tabs[tab]["url"].as_str().unwrap().ends_with("checkout") {
                    "Order"
                } else {
                    "Continue"
                };
                let price = if tab == "product-a" { 18 } else { 12 };
                let body = raw.split_once('\n').unwrap().1;
                json!({"status":"ok","tab":tab,"obs":format!("{tab}-o{index}"),"url":tabs[tab]["url"],
                    "text":format!("tab {tab} epoch 1 obs {tab}-o{index}\nbutton \"{button}\" [f0-e90]\n{page}\nPrice {price}\n{body}")})
            }
            "tab.prepare" => {
                json!({"status":"ok","tab":tab,"url":tabs[tab]["url"],"profile":"signed_out",
                "purchase_allowed":true,"steps":[{"action":frame["args"]["steps"][0]["action"],"hit":{"role":"button","name":"Order","frame":""},"payment":tabs[tab]["url"].as_str().unwrap().ends_with("checkout"),"submit":tabs[tab]["url"].as_str().unwrap().ends_with("checkout")}]})
            }
            "tab.act" => {
                assert_ne!(
                    frame["args"]["steps"][0]["commits"], true,
                    "executor must not dispatch committing actions"
                );
                if failures > 0 {
                    failures -= 1;
                    let path = format!(
                        "/internal/browser-host/results/{}",
                        frame["id"].as_str().unwrap()
                    );
                    admin.send(Method::POST, &path, Some(json!({"status":"stale_ref","reason":"The page changed.","recovery":"Observe again and use the new refs."})), &[]).await?;
                    continue;
                }
                let current = tabs[tab]["url"].as_str().unwrap();
                if current.ends_with("cart") || current.ends_with("product-b") {
                    let destination = if current.ends_with("cart") {
                        "checkout"
                    } else {
                        "cart"
                    };
                    tabs.get_mut(tab).unwrap()["url"] =
                        json!(format!("https://store.example/{destination}"));
                    admin
                        .send(
                            Method::POST,
                            "/internal/browser-host/events",
                            Some(json!({"tabs":tabs.values().collect::<Vec<_>>()})),
                            &[],
                        )
                        .await?;
                }
                actions.fetch_add(1, Ordering::SeqCst);
                json!({"status":"ok","tab":tab,"completed":1,"steps":[{"status":"completed"}]})
            }
            "tabs.list" => json!({"status":"ok","tabs":tabs.values().collect::<Vec<_>>()}),
            "tab.read" => json!({"status":"ok","url":tabs[tab]["url"],"epoch":1,
                "html":format!("{}<article><p>{}</p><p>{}</p></article>", super::shop::PAGES[2].1, "Complete product material. ".repeat(100), "가격 price options. ".repeat(100))}),
            op => panic!("unexpected browser operation {op}"),
        };
        let path = format!(
            "/internal/browser-host/results/{}",
            frame["id"].as_str().unwrap()
        );
        let reply = admin.send(Method::POST, &path, Some(result), &[]).await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
    }
    Ok(())
}
