use super::*;

pub(super) async fn retry_server(
    responses: Vec<Vec<u8>>,
) -> (Url, tokio::task::JoinHandle<Vec<Vec<u8>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = Url::parse(&format!(
        "http://{}/v1/responses",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let task = tokio::spawn(async move {
        let mut requests = Vec::with_capacity(responses.len());
        for response in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut part = [0_u8; 4096];
            loop {
                let read = socket.read(&mut part).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&part[..read]);
                if let Some(header) = request.windows(4).position(|value| value == b"\r\n\r\n") {
                    let length = String::from_utf8_lossy(&request[..header])
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(str::trim)
                                .and_then(|value| value.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if request.len() >= header + 4 + length {
                        break;
                    }
                }
            }
            socket.write_all(&response).await.unwrap();
            requests.push(request);
        }
        requests
    });
    (endpoint, task)
}

fn messages() -> [ModelRoundMessage; 1] {
    [ModelRoundMessage {
        role: ModelRoundRole::User,
        content: "hello".into(),
        tool_call_id: None,
        name: None,
        tool_calls: None,
        image_attachments: Vec::new(),
        provider_data: None,
        request_segment_kind: None,
        operation_result_reference: None,
        operation_result_call_id: None,
        continuation_item_id: Some("turn-item-0".into()),
    }]
}

pub(super) fn provider(endpoint: Url, model_ref: &str) -> (ModelProvider, Arc<Observations>) {
    let (catalog, snapshot) = catalog();
    let metadata = snapshot.find_model_metadata(Some(model_ref)).unwrap();
    let observations = Arc::new(Observations::default());
    (
        ModelProvider::new(
            crate::models::provider_http_client().unwrap(),
            Arc::new(Config {
                metadata,
                endpoint,
                snapshot,
                codex: false,
            }),
            observations.clone(),
            catalog,
            Arc::new(TestClock::at(1_000)),
            Arc::new(Metrics),
        ),
        observations,
    )
}

pub(super) async fn hosted_sse_eof_without_done_is_interrupted() {
    let body = b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        String::from_utf8_lossy(body)
    )
    .into_bytes();
    let (endpoint, server) = retry_server(vec![response]).await;
    let (provider, observations) = provider(endpoint, "qwen/qwen3.7-max");
    let messages = messages();

    let error = provider
        .run_round(request(
            "qwen/qwen3.7-max",
            &messages,
            &ReasoningEffort::Medium,
            CancellationToken::new(),
            None,
        ))
        .await
        .unwrap_err();
    server.await.unwrap();

    assert!(matches!(
        error,
        ModelRoundError::Provider(error) if error.code == "provider_stream_interrupted" && error.retryable
    ));
    assert_eq!(observations.responses.load(Ordering::SeqCst), 0);
    assert_eq!(observations.failures.load(Ordering::SeqCst), 1);
}
