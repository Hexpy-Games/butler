use super::{
    fixture::Task,
    live_proxy::{Proxy, Spend},
    live_usage,
};
use axum::{
    Router,
    body::{Body, Bytes},
    routing::post,
};
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

// test-category: security
#[tokio::test]
async fn live_forwarder_preserves_wire_accounts_usage_and_refuses_egress()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let request = Bytes::from_static(b"{ \"messages\":[], \"model\":\"arbitrary\" }");
    let received = Arc::new(Mutex::new(Bytes::new()));
    let captured = received.clone();
    let usage = json!({"prompt_tokens":1000,"prompt_cache_hit_tokens":250,
        "prompt_cache_miss_tokens":750,"completion_tokens":120,
        "completion_tokens_details":{"reasoning_tokens":100}});
    let wire = format!("data: {}\n\ndata: [DONE]\n\n", json!({"usage":usage}));
    let response = wire.clone();
    let app = Router::new().route(
        "/chat/completions",
        post(move |body: Bytes| {
            let captured = captured.clone();
            let response = response.clone();
            async move {
                *captured.lock().unwrap() = body;
                let parts = response
                    .as_bytes()
                    .chunks(3)
                    .map(|c| Ok::<_, std::io::Error>(Bytes::copy_from_slice(c)))
                    .collect::<Vec<_>>();
                (
                    [("content-type", "text/event-stream")],
                    Body::from_stream(futures_util::stream::iter(parts)),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let upstream = format!("http://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let spend = Arc::new(Mutex::new(Spend {
        max: 0.00001,
        ..Spend::default()
    }));
    let task = Arc::new(Task {
        spec: json!({"facts":[]}),
        pages: Default::default(),
    });
    let proxy = Proxy::with_upstream(upstream, task, spend.clone(), "arbitrary").await?;
    let result = check_proxy(&proxy, request.clone(), &wire).await;
    server.abort();
    result?;
    assert_eq!(*received.lock().unwrap(), request);
    let traffic = proxy.traffic.lock().unwrap();
    assert_eq!(traffic.requests.len(), 1);
    assert_eq!(traffic.requests[0]["usage"], usage);
    assert_eq!(traffic.refused_hosts, ["outside.example"]);
    assert!(traffic.stopped);
    assert!((spend.lock().unwrap().total - 0.000_370_5).abs() < 1e-12);
    Ok(())
}
async fn check_proxy(proxy: &Proxy, request: Bytes, wire: &str) -> Result<(), HarnessError> {
    let client = reqwest::Client::builder().no_proxy().build()?;
    let url = format!("{}/chat/completions", proxy.base);
    assert_eq!(
        client
            .post(&url)
            .body(request.clone())
            .send()
            .await?
            .text()
            .await?,
        wire
    );
    assert_eq!(client.post(&url).body(request).send().await?.status(), 402);
    let sink = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(&proxy.sink)?)
        .build()?;
    assert!(
        sink.get("https://outside.example/page?secret=omitted")
            .send()
            .await
            .is_err()
    );
    Ok(())
}

// test-category: pure-logic
#[test]
fn live_usage_prices_prompt_tiers_and_matches_only_received_reader_text() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let usage = json!({"prompt_tokens":300_000,"prompt_cache_hit_tokens":200_000,
        "prompt_cache_miss_tokens":100_000,"completion_tokens":1000});
    assert!((live_usage::price("openai/gpt-6.1-sol", &usage) - 0.455).abs() < 1e-12);
    let task = Task {
        spec: json!({"facts":[{"page":"https://source.example", "any":["mass 25 kg"]}]}),
        pages: Default::default(),
    };
    let mut body = json!({"messages":[{"role":"tool","content":json!({"output":{
        "source_url":"https://source.example","query":"mass 25 kg","markdown":"Nothing here"}}).to_string()}]});
    assert!(live_usage::received(&body, &task).is_empty());
    body["messages"][0]["content"] = json!(
        json!({"output":{
        "source_url":"https://source.example","markdown":"Mass   25 kg"}})
        .to_string()
    );
    assert_eq!(live_usage::received(&body, &task).len(), 1);
    assert_eq!(
        live_usage::lane(
            &json!({"messages":[{"role":"user","content":"role: worker\nassigned_objective: arbitrary"}]})
        ),
        "worker"
    );
    assert_eq!(
        live_usage::lane(
            &json!({"messages":[{"role":"user","content":"role: steward\nobjective: arbitrary"}]})
        ),
        "steward"
    );
    assert_eq!(
        live_usage::lane(&json!({"messages":[{"role":"user","content":"ordinary research"}]})),
        "butler"
    );
    let invalid: Value = json!({"prompt_tokens":1,"completion_tokens":1});
    assert!(!live_usage::valid(&invalid));
    Ok(())
}

#[tokio::test]
async fn live_wait_collects_delegated_answer_after_admission_turn_delivers()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    use butler_e2e::e2e::{cassette::Cassette, scenario::Setup};
    use std::time::Duration;
    let (base, script, server) = crate::steward_presentation::stub::start().await?;
    let setup = Setup::new("RESEARCH-LIVE-WAIT")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{base}/v1"))
        .env("BUTLER_E2E_HOLD_TOOL", "read_file");
    *script.workspace.lock().unwrap() = setup.sandbox.data.display().to_string();
    for (file, text) in [
        ("a.txt", "Approach A"),
        ("b.txt", "Approach B"),
        ("e2e-hold-tool", "once"),
    ] {
        tokio::fs::write(setup.sandbox.data.join(file), text).await?;
    }
    let s = setup.start().await?;
    let task = Arc::new(Task {
        spec: json!({"facts":[]}),
        pages: Default::default(),
    });
    let proxy = Proxy::with_upstream(
        "http://127.0.0.1:1".into(),
        task,
        Arc::new(Mutex::new(Spend {
            max: 1.0,
            ..Spend::default()
        })),
        "arbitrary",
    )
    .await?;
    let (_, initial) = s
        .turn("general", crate::steward_presentation::stub::OWNER)
        .await?;
    assert_eq!(initial["state"], "delivered");
    let hold = s.sandbox.data.join("e2e-hold-tool");
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        let (result, release) = tokio::join!(super::live_execute::wait(&s, &proxy), async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            tokio::fs::remove_file(hold).await?;
            script.release.notify_one();
            Ok::<_, std::io::Error>(())
        });
        release?;
        result
    })
    .await;
    let finish = s.finish().await;
    server.abort();
    finish?;
    let result = result.map_err(|_| HarnessError("delegated answer did not settle".into()))??;
    assert_eq!(result.status, "complete");
    assert_eq!(result.answer, "Approach B verified.");
    Ok(())
}

// test-category: security
#[tokio::test]
async fn live_forwarder_refuses_a_different_model_before_any_upstream_call()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let task = Arc::new(Task {
        spec: json!({"facts":[]}),
        pages: Default::default(),
    });
    let spend = Arc::new(Mutex::new(Spend {
        max: 1.0,
        ..Spend::default()
    }));
    let proxy = Proxy::with_upstream(
        "http://127.0.0.1:1".into(),
        task,
        spend.clone(),
        "allowed-model",
    )
    .await?;
    let response = reqwest::Client::builder()
        .no_proxy()
        .build()?
        .post(format!("{}/chat/completions", proxy.base))
        .json(&json!({"model":"different-model","messages":[]}))
        .send()
        .await?;
    assert_eq!(response.status(), 400);
    assert_eq!(proxy.traffic.lock().unwrap().rejected_model_requests, 1);
    assert_eq!(proxy.traffic.lock().unwrap().requests, [] as [Value; 0]);
    assert_eq!(spend.lock().unwrap().total, 0.0);
    Ok(())
}

// test-category: security
#[tokio::test]
async fn live_forwarder_meters_disconnected_inflight_request_at_spend_guard()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    use futures_util::StreamExt;
    use std::time::Duration;
    let release = Arc::new(tokio::sync::Notify::new());
    let gate = release.clone();
    let usage = json!({"prompt_tokens":10,"prompt_cache_hit_tokens":2,
        "prompt_cache_miss_tokens":8,"completion_tokens":3});
    let wire = format!("data: {}\n\ndata: [DONE]\n\n", json!({"usage":usage}));
    let app = Router::new().route(
        "/chat/completions",
        post(move || {
            let gate = gate.clone();
            let wire = wire.clone();
            async move {
                let first = futures_util::stream::once(async {
                    Ok::<_, std::io::Error>(Bytes::from_static(b": ping\n\n"))
                });
                let last = futures_util::stream::once(async move {
                    gate.notified().await;
                    Ok::<_, std::io::Error>(Bytes::from(wire))
                });
                (
                    [("content-type", "text/event-stream")],
                    Body::from_stream(first.chain(last)),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let upstream = format!("http://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let task = Arc::new(Task {
        spec: json!({"facts":[]}),
        pages: Default::default(),
    });
    let spend = Arc::new(Mutex::new(Spend {
        max: 1e-7,
        ..Spend::default()
    }));
    let proxy = Proxy::with_upstream(upstream, task, spend.clone(), "arbitrary").await?;
    let mut response = reqwest::Client::builder()
        .no_proxy()
        .build()?
        .post(format!("{}/chat/completions", proxy.base))
        .json(&json!({"model":"arbitrary","messages":[]}))
        .send()
        .await?;
    assert_eq!(
        response.chunk().await?.unwrap(),
        Bytes::from_static(b": ping\n\n")
    );
    drop(response);
    release.notify_one();
    let settled = tokio::time::timeout(Duration::from_secs(5), proxy.settle()).await;
    server.abort();
    assert!(settled.map_err(|_| HarnessError("usage drain did not finish".into()))?);
    let traffic = proxy.traffic.lock().unwrap();
    assert_eq!(traffic.pending, 0);
    assert_eq!(traffic.requests[0]["usage"], usage);
    assert!(traffic.stopped);
    let spend = spend.lock().unwrap();
    assert!(spend.total > spend.max);
    Ok(())
}

// test-category: security
#[tokio::test]
async fn live_forwarder_preserves_provider_rejection_and_allows_next_request()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    use axum::response::IntoResponse;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let rejected =
        json!({"error":{"code":"invalid_request_error","message":"Invalid request format"}});
    let error = rejected.clone();
    let usage = json!({"prompt_tokens":10,"prompt_cache_hit_tokens":2,
        "prompt_cache_miss_tokens":8,"completion_tokens":3});
    let accepted = json!({"usage":usage});
    let app = Router::new().route(
        "/chat/completions",
        post(move || {
            let first = seen.fetch_add(1, Ordering::SeqCst) == 0;
            let value = if first {
                error.clone()
            } else {
                accepted.clone()
            };
            async move {
                (
                    if first {
                        http::StatusCode::BAD_REQUEST
                    } else {
                        http::StatusCode::OK
                    },
                    axum::Json(value),
                )
                    .into_response()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let upstream = format!("http://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let task = Arc::new(Task {
        spec: json!({"facts":[]}),
        pages: Default::default(),
    });
    let spend = Arc::new(Mutex::new(Spend {
        max: 1.0,
        ..Spend::default()
    }));
    let proxy = Proxy::with_upstream(upstream, task, spend.clone(), "arbitrary").await?;
    let client = reqwest::Client::builder().no_proxy().build()?;
    let url = format!("{}/chat/completions", proxy.base);
    let body = json!({"model":"arbitrary","messages":[]});
    let first = client.post(&url).json(&body).send().await?;
    assert_eq!(first.status(), 400);
    assert_eq!(first.json::<Value>().await?, rejected);
    let second = client
        .post(&url)
        .header("x-research-judge", "1")
        .json(&body)
        .send()
        .await?;
    assert_eq!(second.status(), 200);
    assert_eq!(second.json::<Value>().await?["usage"], usage);
    assert!(proxy.settle().await);
    server.abort();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let traffic = proxy.traffic.lock().unwrap();
    assert_eq!(traffic.requests[0]["usage"], Value::Null);
    assert_eq!(traffic.requests[0]["provider_error"], rejected["error"]);
    assert_eq!(traffic.requests[0]["rejected_request"], body);
    assert_eq!(traffic.requests[0]["round"], 1);
    assert_eq!(
        serde_json::from_str::<Value>(traffic.requests[0]["provider_error_body"].as_str().unwrap())
            .unwrap(),
        rejected
    );
    assert!(live_usage::accounted(&traffic.requests[0]));
    assert_eq!(traffic.requests[1]["lane"], "judge");
    assert!(!traffic.usage_failed);
    assert!(spend.lock().unwrap().judge > 0.0);
    Ok(())
}
