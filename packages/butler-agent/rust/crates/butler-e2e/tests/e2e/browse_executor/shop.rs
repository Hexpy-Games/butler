//! Shared offline shop and stub-reported usage comparison. No live model calls.
use super::*;
use butler_e2e::e2e::{cassette::Cassette, scenario::Scenario};
use butler_runtime::outputs::{OutputStore, PublishRequest};
pub(crate) const PAGES: [(&str, &str); 5] = [
    (
        "index.html",
        include_str!("../../../fixtures/browse-shop/index.html"),
    ),
    (
        "product-a.html",
        include_str!("../../../fixtures/browse-shop/product-a.html"),
    ),
    (
        "product-b.html",
        include_str!("../../../fixtures/browse-shop/product-b.html"),
    ),
    (
        "cart.html",
        include_str!("../../../fixtures/browse-shop/cart.html"),
    ),
    (
        "checkout.html",
        include_str!("../../../fixtures/browse-shop/checkout.html"),
    ),
];
const TASK: &str =
    "Compare the desk lamps, add the cheaper lamp to the cart and request order approval";
const ANSWER: &str = "Aster desk lamp: 18. Birch desk lamp: 12. Cheaper: Birch desk lamp.";

pub(crate) async fn publish(s: &Scenario) -> Result<String, HarnessError> {
    let data = s.sandbox.data.clone();
    let workspace = s.sandbox.workspace.clone();
    let id = tokio::task::spawn_blocking(move || -> Result<String, HarnessError> {
        let path = workspace.join("shop");
        std::fs::create_dir_all(&path)?;
        for (name, html) in PAGES {
            std::fs::write(path.join(name), html)?;
        }
        let (output, _) = OutputStore::new(&data).publish(PublishRequest {
            workspace,
            path: "shop".into(),
            entry: Some("index.html".into()),
            title: "Desk lamps".into(),
            session_id: "general".into(),
            message_id: "shop".into(),
            turn_id: "shop".into(),
        })?;
        Ok(output.output_id)
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))??;
    let view = s.gw.get(&format!("/outputs/{id}/view")).await?;
    assert_eq!(view.status, 200, "{}", view.text);
    Ok(view.data()["url"].as_str().unwrap().to_owned())
}

fn cassette(auto: bool) -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut c = Cassette::load("TOOL-01")?;
    c.exchanges.clear();
    let calls = if auto {
        vec![(
            "browse",
            json!({"goal":"Compare lamp prices","url":"https://store.example/listing","fields":["aster","birch","cheaper"]}),
        )]
    } else {
        vec![
            (
                "browser_open",
                json!({"url":"https://store.example/listing"}),
            ),
            (
                "browser_observe",
                json!({"tab":"listing","full":true,"look":"never"}),
            ),
            (
                "browser_open",
                json!({"url":"https://store.example/product-a"}),
            ),
            (
                "browser_observe",
                json!({"tab":"product-a","full":true,"look":"never"}),
            ),
            (
                "browser_open",
                json!({"url":"https://store.example/product-b"}),
            ),
            (
                "browser_observe",
                json!({"tab":"product-b","full":true,"look":"never"}),
            ),
            (
                "browser_act",
                json!({"tab":"product-b","observation":"product-b-o1","observe":true,"steps":[{"action":"click","ref":"f0-e90"}]}),
            ),
            (
                "browser_act",
                json!({"tab":"product-b","observation":"product-b-o2","observe":true,"steps":[{"action":"click","ref":"f0-e90"}]}),
            ),
            (
                "browser_act",
                json!({"tab":"product-b","observation":"product-b-o3","steps":stub::commit()}),
            ),
        ]
    };
    crate::browser_prefix::add_turn(&mut c, &template, TASK, calls, ANSWER);
    if auto {
        c.exchanges[0].response = stub::response(&[stub::call(
            "browse",
            &json!({"goal":"Compare lamp prices","url":"https://store.example/listing","fields":["aster","birch","cheaper"]}),
            "prices",
        )]);
        c.exchanges[1].response = stub::response(&[stub::call(
            "browse",
            &json!({"goal":"Reach shop checkout","tab":"product-b"}),
            "cart",
        )]);
        let mut approval = template.exchanges[0].clone();
        approval.request.key.user_request = TASK.into();
        approval.request.key.round = vec![
            "function_call".into(),
            "function_call_output".into(),
            "function_call".into(),
            "function_call_output".into(),
        ];
        approval.response = stub::response(&[stub::call(
            "browser_act",
            &json!({"tab":"product-b","observation":"product-b-o4","steps":stub::commit()}),
            "purchase",
        )]);
        c.exchanges.push(approval);
        for next in [
            json!({"open":{"url":"https://store.example/product-a"}}),
            json!({"open":{"url":"https://store.example/product-b"}}),
            json!({"done":{"fields":{"aster":"18","birch":"12","cheaper":"Birch desk lamp"},"evidence":[{"field":"aster","quote":"Price 18"},{"field":"birch","quote":"Price 12"},{"field":"cheaper","quote":"Birch desk lamp"}],"summary":ANSWER}}),
        ] {
            let mut exchange = template.exchanges[1].clone();
            exchange.request.key.user_request = "Compare lamp prices".into();
            exchange.request.key.round.clear();
            exchange.response = stub::message(
                &json!({"notes":"Aster desk lamp: Price 18","next":next}).to_string(),
            );
            c.exchanges.push(exchange);
        }
        for next in [
            json!({"act":{"steps":[{"action":"click","ref":"f0-e90"}]}}),
            json!({"act":{"steps":[{"action":"click","ref":"f0-e90"}]}}),
            json!({"act":{"steps":stub::commit()}}),
        ] {
            let mut exchange = template.exchanges[1].clone();
            exchange.request.key.user_request = "Reach shop checkout".into();
            exchange.request.key.round.clear();
            exchange.response = stub::message(
                &json!({"notes":"Birch desk lamp is in the cart.","next":next}).to_string(),
            );
            c.exchanges.push(exchange);
        }
    }
    Ok(c)
}

#[tokio::test]
async fn shop_complete_results_auto_input_does_not_exceed_off() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut totals = Vec::new();
    for auto in [false, true] {
        let s = Setup::new("BROWSE-SHOP-USAGE")?
            .stub_cassette(cassette(auto)?)
            .start()
            .await?;
        let setting = if auto { "auto" } else { "off" };
        let reply =
            s.gw.patch("/settings", json!({"browser":{"browsing_agent":setting}}))
                .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        let (host, actions) = host::start(&s).await?;
        let id = s.gw.say_turn("general", TASK).await?;
        let turn =
            s.gw.wait_turn(
                "general",
                &id,
                &["waiting_for_form", "delivered", "failed"],
                Duration::from_secs(30),
            )
            .await?;
        assert_eq!(
            turn["state"],
            "waiting_for_form",
            "{turn}\n{}",
            s.agent.logs()
        );
        let requests = s.provider()?.requests();
        let results = outputs(requests.last().unwrap());
        if auto {
            let result = &results
                .iter()
                .find(|(v, _)| v["output"]["status"] == "done")
                .unwrap()
                .0["output"];
            assert_eq!(
                result["fields"],
                json!({"aster":"18","birch":"12","cheaper":"Birch desk lamp"})
            );
            assert_eq!(result["evidence"].as_array().unwrap().len(), 3);
            assert_eq!(result["unverified"], json!([]));
        } else {
            let surface = requests[0]["tools"].to_string();
            assert!(!surface.contains("\"name\":\"browse\""));
            for name in [
                "browser_open",
                "browser_observe",
                "browser_act",
                "browser_close",
                "image_collect",
            ] {
                assert!(
                    surface.contains(&format!("\"name\":\"{name}\"")),
                    "{surface}"
                );
            }
            let text = results
                .iter()
                .map(|(v, _)| v.to_string())
                .collect::<Vec<_>>()
                .join("\n");
            for fact in ["Aster desk lamp", "Price 18", "Birch desk lamp", "Price 12"] {
                assert!(text.contains(fact), "missing {fact}");
            }
        }
        let cards = s.gw.approval_requests("general").await?;
        assert_eq!(cards.len(), 1);
        let operation = &cards[0]["approval"]["operation"];
        assert_eq!(operation["tool"], "browser_act");
        assert_eq!(operation["browser_steps"][0]["action"], "click");
        assert_eq!(operation["browser_steps"][0]["name"], "Order");
        assert_eq!(
            actions.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "add to cart and reach checkout; order never dispatched"
        );
        let reached = crate::browser_headless::support::call(
            &AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap()),
            "general",
            "tab.observe",
            &json!("product-b"),
            json!({}),
        )
        .await?;
        assert!(
            reached["text"]
                .as_str()
                .unwrap()
                .contains("Birch desk lamp in cart")
        );
        assert!(reached["text"].as_str().unwrap().contains("Checkout"));
        let view = s.gw.get("/session-view?session_id=general").await?;
        let usage = &view.data()["usage"];
        let input = usage["input_tokens"].as_u64().unwrap();
        assert_eq!(
            input,
            requests.len() as u64 * 100,
            "all planner and executor usage counted"
        );
        println!("BROWSE-SHOP setting={setting} stub_reported_input_tokens={input} complete=true");
        totals.push(input);
        host.abort();
        let _ = host.await;
        s.finish().await?;
    }
    assert!(
        totals[1] <= totals[0],
        "Auto input {} exceeds Off {}",
        totals[1],
        totals[0]
    );
    Ok(())
}
