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
        facts: Default::default(),
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

struct RejectSecondAdmission(AtomicUsize);

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

#[tokio::test]
async fn codex_fallback_stream_id_is_reused_and_final_id_samples_separately() {
    let body = concat!(
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"a\"}\n\n",
        "data: {\"type\":\"response.output_text.delta\",\"response_id\":\"explicit\",\"delta\":\"b\"}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"output\":[]}}\n\n",
    )
    .as_bytes();
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        String::from_utf8_lossy(body)
    )
    .into_bytes();
    let (endpoint, server) = retry_server(vec![response]).await;
    let (catalog, snapshot) = catalog();
    let metadata = snapshot
        .find_model_metadata(Some("openai/gpt-5.5"))
        .unwrap();
    let provider = ModelProvider::new(
        crate::models::provider_http_client().unwrap(),
        Arc::new(Config {
            metadata,
            endpoint,
            snapshot,
            codex: true,
        }),
        Arc::new(Observations::default()),
        catalog,
        Arc::new(TestClock::at(4_200)),
        Arc::new(Metrics),
    );
    let messages = messages();
    let events = StreamEvents::default();
    let mut input = request(
        "openai/gpt-5.5",
        &messages,
        &ReasoningEffort::Medium,
        CancellationToken::new(),
        None,
    );
    input.stream_observer = Some(&events);

    let result = provider.run_round(input).await.unwrap();
    server.await.unwrap();
    let events = events.0.lock().unwrap();
    assert_eq!(events[0]["streamId"], "codex-stream-4200");
    assert_eq!(events[1]["streamId"], "explicit");
    assert_eq!(events[2]["streamId"], "codex-stream-4200");
    assert_eq!(result.raw.unwrap()["id"], "codex-4201");
}

impl ProviderBodyAdmissionPort for RejectSecondAdmission {
    fn admit(
        &self,
        _: usize,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), ModelRoundError>> + Send + '_>>
    {
        let call = self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if call == 0 {
                Ok(())
            } else {
                Err(ModelRoundError::StablePrefix(
                    "second-admission-rejected".into(),
                ))
            }
        })
    }
}

#[tokio::test]
async fn each_retry_is_readmitted_and_rejection_stops_before_second_fetch() {
    let body = br#"{"error":{"message":"temporary"}}"#;
    let response = format!(
        "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        String::from_utf8_lossy(body)
    )
    .into_bytes();
    let (endpoint, server) = retry_server(vec![response]).await;
    let (provider, observations) = provider(endpoint, "openai/gpt-5.5");
    let messages = messages();
    let admission = RejectSecondAdmission(AtomicUsize::new(0));
    let mut input = request(
        "openai/gpt-5.5",
        &messages,
        &ReasoningEffort::Medium,
        CancellationToken::new(),
        Some(&admission),
    );
    input.provider_retry_attempts = Some(2.0);

    let error = provider.run_round(input).await.unwrap_err();
    let requests = server.await.unwrap();

    assert!(matches!(
        error,
        ModelRoundError::StablePrefix(code) if code == "second-admission-rejected"
    ));
    assert_eq!(admission.0.load(Ordering::SeqCst), 2);
    assert_eq!(requests.len(), 1);
    assert_eq!(observations.failures.load(Ordering::SeqCst), 0);
}

#[derive(Default)]
struct StreamEvents(std::sync::Mutex<Vec<serde_json::Value>>);

impl butler_turn::btcc::ProviderStreamObserver for StreamEvents {
    fn event(&self, event: &serde_json::Value) {
        self.0.lock().unwrap().push(event.clone());
    }
}
