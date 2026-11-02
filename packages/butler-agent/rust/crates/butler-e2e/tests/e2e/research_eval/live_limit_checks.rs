use super::{
    fixture::Task,
    live_limits::TaskBudget,
    live_proxy::{Proxy, Spend},
};
use axum::{Router, routing::post};
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup};
use serde_json::json;
use std::sync::{Arc, Mutex};

#[tokio::test]
async fn live_task_caps_stop_runaway_allow_judge_and_continue_next_task() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let s = Setup::new("RESEARCH-TASK-CAPS")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .start()
        .await?;
    s.provider()?
        .set_chat_responder(crate::briefing_effort::briefing);
    let usage = json!({"prompt_tokens":10,"prompt_cache_hit_tokens":2,
        "prompt_cache_miss_tokens":8,"completion_tokens":3});
    let wire = format!(
        "data: {}\n\ndata: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"browser_"}}]}}]}),
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"open"}}]}}]}),
        json!({"usage":usage})
    );
    let app = Router::new().route(
        "/chat/completions",
        post(move || {
            let wire = wire.clone();
            async move { ([("content-type", "text/event-stream")], wire) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let upstream = format!("http://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let spend = Arc::new(Mutex::new(Spend {
        max: 1.0,
        ..Default::default()
    }));
    for (max_usd, max_calls, admitted) in [(1e-9, 400, 1), (2.0, 1, 2)] {
        check_limit(&s, &upstream, spend.clone(), max_usd, max_calls, admitted).await?;
    }
    let next = proxy(&upstream, spend.clone()).await?;
    request(&next, false, 200).await?;
    assert!(next.settle().await);
    assert!(!next.traffic.lock().unwrap().budget.runaway);
    assert!(spend.lock().unwrap().judge > 0.0);
    server.abort();
    s.finish().await
}

async fn proxy(upstream: &str, spend: Arc<Mutex<Spend>>) -> Result<Proxy, HarnessError> {
    let task = Arc::new(Task {
        spec: json!({"facts":[]}),
        pages: Default::default(),
    });
    Proxy::with_upstream(upstream.into(), task, spend, "arbitrary").await
}
async fn request(proxy: &Proxy, judge: bool, status: u16) -> Result<(), HarnessError> {
    let mut request = reqwest::Client::builder()
        .no_proxy()
        .build()?
        .post(format!("{}/chat/completions", proxy.base))
        .json(&json!({"model":"arbitrary","messages":[]}));
    if judge {
        request = request.header("x-research-judge", "1");
    }
    let reply = request.send().await?;
    assert_eq!(reply.status().as_u16(), status);
    reply.bytes().await?;
    Ok(())
}

async fn check_limit(
    s: &butler_e2e::e2e::scenario::Scenario,
    upstream: &str,
    spend: Arc<Mutex<Spend>>,
    max_usd: f64,
    max_calls: usize,
    admitted: usize,
) -> Result<(), HarnessError> {
    let proxy = proxy(upstream, spend).await?;
    proxy.traffic.lock().unwrap().budget = TaskBudget {
        max_usd,
        max_calls,
        ..Default::default()
    };
    for _ in 0..admitted {
        request(&proxy, false, 200).await?;
    }
    assert!(proxy.settle().await);
    let result = super::live_execute::wait(s, &proxy).await?;
    assert_eq!(result.status, "runaway");
    assert_eq!(result.answer, "");
    request(&proxy, false, 402).await?;
    request(&proxy, true, 200).await?;
    assert!(proxy.settle().await);
    let traffic = proxy.traffic.lock().unwrap();
    assert_eq!(traffic.budget.calls, admitted);
    assert_eq!(traffic.requests.len(), admitted + 1);
    assert_eq!(
        traffic.budget.top_tools(),
        json!([{"tool":"browser_open","count":admitted}])
    );
    assert!(!traffic.stopped);
    Ok(())
}
