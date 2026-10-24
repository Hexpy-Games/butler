use super::*;
use butler_e2e::e2e::cassette::Cassette;

fn cassette(replies: &[String]) -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut c = Cassette::load("TOOL-01")?;
    c.exchanges.clear();
    let mut first = template.exchanges[0].clone();
    first.request.key.user_request = "Recover page task".into();
    first.request.key.round.clear();
    first.response = stub::response(&[stub::call(
        "browse",
        &json!({"goal":"Inspect page","url":"https://store.example/product-b","fields":["price"]}),
        "recover",
    )]);
    c.exchanges.push(first);
    for reply in replies {
        let mut exchange = template.exchanges[1].clone();
        exchange.request.key.user_request = "Inspect page".into();
        exchange.request.key.round.clear();
        exchange.response = stub::message(reply);
        c.exchanges.push(exchange);
    }
    let mut last = template.exchanges[1].clone();
    last.request.key.user_request = "Recover page task".into();
    last.request.key.round = vec!["function_call".into(), "function_call_output".into()];
    last.response = stub::message("Recovered or reported the last failure.");
    c.exchanges.push(last);
    Ok(c)
}

#[tokio::test]
async fn fenced_json_long_notes_and_stale_step_recover_with_feedback() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let act = json!({"notes":"가".repeat(2001),"next":{"act":{"steps":[{"action":"click","ref":"f0-e90"}]}}});
    let done = json!({"notes":"Price 12","next":{"done":{"fields":{"price":"12"},"evidence":[{"field":"price","quote":"Price 12"}],"summary":"Found price."}}});
    let s = Setup::new("BROWSE-RECOVERY")?
        .stub_cassette(cassette(&[
            format!("Here:\n```json\n{act}\n```"),
            done.to_string(),
        ])?)
        .start()
        .await?;
    let reply =
        s.gw.patch("/settings", json!({"browser":{"browsing_agent":"auto"}}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let (host, _) = host::start_with_failures(&s, 1).await?;
    let (_, turn) = s.turn("general", "Recover page task").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = s.provider()?.requests();
    let result = outputs(requests.last().unwrap()).pop().unwrap().0["output"].clone();
    assert_eq!(result["status"], "done", "{result}");
    assert_eq!(result["fields"]["price"], "12");
    assert_eq!(result["evidence"][0]["quote"], "Price 12");
    let second = requests.iter().filter(|r| executor(r)).nth(1).unwrap();
    let text = second["input"][0]["content"][0]["text"].as_str().unwrap();
    let scope: Value = serde_json::from_str(text.split_once("Current scope:\n").unwrap().1)?;
    assert_eq!(scope["notes"].as_str().unwrap().chars().count(), 2000);
    assert!(
        scope["notes_notice"]
            .as_str()
            .unwrap()
            .contains("cut at 2,000 characters")
    );
    assert!(scope["action_log"].to_string().contains("stale_ref"));
    assert!(
        scope["action_log"]
            .to_string()
            .contains("Observe again and use the new refs.")
    );
    assert!(scope["view"]["obs"].as_str().unwrap().ends_with("o2"));
    host.abort();
    let _ = host.await;
    s.finish().await
}

#[tokio::test]
async fn three_consecutive_unusable_replies_or_failed_steps_end_stuck() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let act = json!({"notes":"","next":{"act":{"steps":[{"action":"click","ref":"f0-e90"}]}}})
        .to_string();
    for replies in [
        vec![act.clone(); 3],
        vec![
            "no object".into(),
            json!({"notes":"","next":{"unknown":{}}}).to_string(),
            json!({"notes":"","next":{"act":{"steps":[{"action":"click","ref":"absent"}]}}})
                .to_string(),
        ],
    ] {
        let s = Setup::new("BROWSE-THREE-FAILURES")?
            .stub_cassette(cassette(&replies)?)
            .start()
            .await?;
        let reply =
            s.gw.patch("/settings", json!({"browser":{"browsing_agent":"auto"}}))
                .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        let (host, actions) = host::start_with_failures(&s, 3).await?;
        let (_, turn) = s.turn("general", "Recover page task").await?;
        assert_eq!(turn["state"], "delivered");
        let requests = s.provider()?.requests();
        let result = outputs(requests.last().unwrap()).pop().unwrap().0["output"].clone();
        assert_eq!(result["status"], "stuck", "{result}");
        assert_eq!(result["steps_used"], 3);
        assert_eq!(requests.iter().filter(|r| executor(r)).count(), 3);
        assert_eq!(actions.load(std::sync::atomic::Ordering::SeqCst), 0);
        let reason = result["summary"].to_string();
        assert!(
            reason.contains("stale_ref") || reason.contains("invalid_steps"),
            "{reason}"
        );
        host.abort();
        let _ = host.await;
        s.finish().await?;
    }
    Ok(())
}
