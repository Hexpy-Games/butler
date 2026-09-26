use super::*;

fn ignore_request() {}

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

pub(super) fn provider(endpoint: Url, model_ref: &str) -> (NativeModelProvider, Arc<Observations>) {
    let (catalog, snapshot) = catalog();
    let metadata = snapshot.find_model_metadata(Some(model_ref)).unwrap();
    let observations = Arc::new(Observations::default());
    (
        NativeModelProvider::new(
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

#[tokio::test]
async fn retryable_http_failure_replays_the_same_owned_request() {
    let failure = br#"{"error":{"message":"temporary"}}"#;
    let failure_response = format!(
        "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        failure.len(),
        String::from_utf8_lossy(failure)
    )
    .into_bytes();
    let success = br#"{"id":"resp_2","model":"gpt-5.5","output":[{"type":"message","content":[{"type":"output_text","text":"recovered"}]}]}"#;
    let success_response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        success.len(),
        String::from_utf8_lossy(success)
    )
    .into_bytes();
    let (endpoint, server) = retry_server(vec![failure_response, success_response]).await;
    let (provider, observations) = provider(endpoint, "openai/gpt-5.5");
    let messages = messages();
    let mut input = request(
        "openai/gpt-5.5",
        &messages,
        &ReasoningEffort::Medium,
        CancellationToken::new(),
        None,
    );
    input.provider_retry_attempts = Some(2.0);

    let result = provider.run_round(input).await.unwrap();
    let requests = server.await.unwrap();

    assert_eq!(result.text.as_deref(), Some("recovered"));
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0], requests[1]);
    assert_eq!(observations.requests.load(Ordering::SeqCst), 1);
    assert_eq!(observations.responses.load(Ordering::SeqCst), 1);
    assert_eq!(observations.failures.load(Ordering::SeqCst), 0);
}

struct RejectSecondAdmission(AtomicUsize);

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

struct PendingAdmission;

impl ProviderBodyAdmissionPort for PendingAdmission {
    fn admit(
        &self,
        _: usize,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), ModelRoundError>> + Send + '_>>
    {
        Box::pin(std::future::pending())
    }
}

#[tokio::test(start_paused = true)]
async fn guard_start_matches_openai_and_shared_carrier_admission_order() {
    let client = crate::models::provider_http_client().unwrap();
    let policy = ProviderRoundPolicy {
        total: Duration::from_secs(1),
        idle: None,
        retry_base_ms: 0.0,
    };
    let shared_client = client.clone();
    let shared = tokio::spawn(async move {
        let clock = TestClock::at(1_000);
        crate::models::transport::execute(crate::models::transport::RequestExecution {
            request: shared_client.post("http://127.0.0.1:1"),
            provider: "qwen",
            api: "chat_completions",
            policy,
            external: CancellationToken::new(),
            mode: crate::models::transport::ResponseMode::Json {
                tolerate_invalid: false,
            },
            stream_observer: None,
            attempts: 1.0,
            admission: Some(&PendingAdmission),
            physical_admission: None,
            serialized_bytes: 1,
            guard_start: crate::models::transport::GuardStart::BeforeAdmission,
            request_observer: &ignore_request,
            clock: &clock,
        })
        .await
    });
    tokio::time::advance(Duration::from_secs(1)).await;
    let error = shared.await.unwrap().unwrap_err();
    assert!(matches!(
        error,
        ModelRoundError::Provider(error)
            if error.code == "provider_round_timeout" && error.timeout_kind.as_deref() == Some("total")
    ));

    let cancellation = CancellationToken::new();
    let request_cancellation = cancellation.clone();
    let openai = tokio::spawn(async move {
        let clock = TestClock::at(1_000);
        crate::models::transport::execute(crate::models::transport::RequestExecution {
            request: client.post("http://127.0.0.1:1"),
            provider: "openai",
            api: "responses",
            policy,
            external: request_cancellation,
            mode: crate::models::transport::ResponseMode::Json {
                tolerate_invalid: false,
            },
            stream_observer: None,
            attempts: 1.0,
            admission: Some(&PendingAdmission),
            physical_admission: None,
            serialized_bytes: 1,
            guard_start: crate::models::transport::GuardStart::AfterAdmission,
            request_observer: &ignore_request,
            clock: &clock,
        })
        .await
    });
    tokio::time::advance(Duration::from_secs(100)).await;
    assert!(!openai.is_finished());
    cancellation.cancel();
    let error = openai.await.unwrap().unwrap_err();
    assert!(matches!(
        error,
        ModelRoundError::Provider(error) if error.code == "provider_cancelled"
    ));
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

#[tokio::test]
async fn hosted_sse_eof_without_done_is_interrupted() {
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
async fn structured_http_failure_preserves_provider_identity() {
    let body = br#"{"error":{"code":"model_not_found","type":"invalid_request_error","message":"The requested model was not found."}}"#;
    let response = format!(
        "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nX-Request-Id: req-safe-1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        String::from_utf8_lossy(body)
    )
    .into_bytes();
    let (endpoint, server) = retry_server(vec![response]).await;
    let (provider, observations) = provider(endpoint, "openai/gpt-5.5");
    let messages = messages();

    let error = provider
        .run_round(request(
            "openai/gpt-5.5",
            &messages,
            &ReasoningEffort::Medium,
            CancellationToken::new(),
            None,
        ))
        .await
        .unwrap_err();
    server.await.unwrap();

    let ModelRoundError::Provider(error) = error else {
        panic!("expected provider error");
    };
    assert_eq!(error.code, "provider_model_not_found");
    assert_eq!(error.status_code, Some(400));
    assert_eq!(
        error.provider_error_code.as_deref(),
        Some("model_not_found")
    );
    assert_eq!(error.provider_request_id.as_deref(), Some("req-safe-1"));
    assert!(!error.retryable);
    assert_eq!(observations.failures.load(Ordering::SeqCst), 1);
}

#[derive(Default)]
struct StreamEvents(std::sync::Mutex<Vec<serde_json::Value>>);

impl crate::btcc::ProviderStreamObserver for StreamEvents {
    fn event(&self, event: &serde_json::Value) {
        self.0.lock().unwrap().push(event.clone());
    }
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
    let provider = NativeModelProvider::new(
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
