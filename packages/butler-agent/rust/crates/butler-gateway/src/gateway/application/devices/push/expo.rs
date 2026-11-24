use butler_log::http::{Client, Phase};
use serde_json::Value;
use std::time::Duration;

pub(super) struct PushError {
    pub(super) code: &'static str,
}

pub(super) async fn send(
    client: &Client,
    url: &str,
    messages: &[Value],
) -> Result<Vec<usize>, PushError> {
    let mut unregistered = Vec::new();
    for (batch, chunk) in messages.chunks(100).enumerate() {
        for attempt in 1..=3 {
            let result = client
                .post(url)
                .header("accept", "application/json")
                .json(chunk)
                .phase(Phase::new("push", attempt).routine().sensitive())
                .send()
                .await;
            match result {
                Ok(response) if response.status().is_success() => {
                    let body: Value = response.json().await.map_err(|_| PushError {
                        code: "push_tickets_invalid",
                    })?;
                    let tickets = body["data"].as_array().ok_or(PushError {
                        code: "push_tickets_invalid",
                    })?;
                    for (index, ticket) in tickets.iter().take(chunk.len()).enumerate() {
                        if ticket["status"] == "error"
                            && ticket["details"]["error"] == "DeviceNotRegistered"
                        {
                            unregistered.push(batch * 100 + index);
                        }
                    }
                    break;
                }
                Ok(response) => {
                    let status = response.status().as_u16();
                    tracing::debug!(status, attempt);
                    if attempt == 3 || !(status == 429 || status >= 500) {
                        return Err(PushError {
                            code: "push_http_failed",
                        });
                    }
                }
                Err(_) => {
                    tracing::debug!(attempt);
                    if attempt == 3 {
                        return Err(PushError {
                            code: "push_network_failed",
                        });
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(1 << (attempt - 1))).await;
        }
    }
    Ok(unregistered)
}
