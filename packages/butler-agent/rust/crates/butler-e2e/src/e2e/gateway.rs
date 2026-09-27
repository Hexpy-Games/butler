//! Authenticated client for the App gateway (the UI's only channel).

use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::{HarnessError, harness_error};

#[derive(Clone)]
pub struct Gateway {
    pub base: String,
    pub token: String,
    client: reqwest::Client,
}

/// One HTTP response: status and JSON body (`Value::Null` when not JSON).
#[derive(Clone, Debug)]
pub struct Reply {
    pub status: u16,
    pub body: Value,
    pub text: String,
}

impl Reply {
    /// `body.data` of a `butler.app.v1` envelope.
    pub fn data(&self) -> &Value {
        &self.body["data"]
    }

    pub fn error_code(&self) -> Option<&str> {
        self.body["error"]["code"].as_str()
    }
}

impl Gateway {
    pub fn new(base: String, token: String) -> Self {
        Self {
            base,
            token,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .unwrap_or_default(),
        }
    }

    pub async fn healthy(&self) -> bool {
        self.get("/health")
            .await
            .is_ok_and(|reply| reply.status == 200 && reply.data()["ok"] == true)
    }

    pub async fn get(&self, path: &str) -> Result<Reply, HarnessError> {
        self.send(reqwest::Method::GET, path, None).await
    }

    pub async fn post(&self, path: &str, body: Value) -> Result<Reply, HarnessError> {
        self.send(reqwest::Method::POST, path, Some(body.to_string()))
            .await
    }

    pub async fn patch(&self, path: &str, body: Value) -> Result<Reply, HarnessError> {
        self.send(reqwest::Method::PATCH, path, Some(body.to_string()))
            .await
    }

    pub async fn delete(&self, path: &str) -> Result<Reply, HarnessError> {
        self.send(reqwest::Method::DELETE, path, None).await
    }

    /// Sends a raw body (for malformed-JSON and oversize cases).
    pub async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<String>,
    ) -> Result<Reply, HarnessError> {
        self.send_with(method, path, body, Some(&self.token), &[])
            .await
    }

    pub async fn send_with(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<String>,
        token: Option<&str>,
        headers: &[(&str, &str)],
    ) -> Result<Reply, HarnessError> {
        let mut request = self.client.request(method, format!("{}{path}", self.base));
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(body);
        }
        let response = request.send().await?;
        let status = response.status().as_u16();
        let text = response.text().await?;
        let body = serde_json::from_str(&text).unwrap_or(Value::Null);
        Ok(Reply { status, body, text })
    }

    /// Raw response (headers needed, e.g. CORS).
    pub async fn raw(
        &self,
        method: reqwest::Method,
        path: &str,
        headers: &[(&str, &str)],
    ) -> Result<reqwest::Response, HarnessError> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(&self.token);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        Ok(request.send().await?)
    }

    pub async fn settings(&self) -> Result<Value, HarnessError> {
        let reply = self.get("/settings").await?;
        expect_status(&reply, 200, "GET /settings")?;
        Ok(reply.data().clone())
    }

    /// `POST /messages` and returns the accepted response data.
    pub async fn send_message(&self, body: Value) -> Result<Value, HarnessError> {
        let reply = self.post("/messages", body).await?;
        expect_status(&reply, 202, "POST /messages")?;
        Ok(reply.data().clone())
    }

    pub async fn say(&self, chat_id: &str, text: &str) -> Result<Value, HarnessError> {
        self.send_message(json!({
            "chat_id": chat_id,
            "text": text,
            "client_message_id": uuid::Uuid::new_v4().to_string(),
        }))
        .await
    }

    pub async fn turns(&self, chat_id: &str) -> Result<Vec<Value>, HarnessError> {
        let reply = self.get(&format!("/turns?chat_id={chat_id}")).await?;
        expect_status(&reply, 200, "GET /turns")?;
        Ok(list(reply.data(), "turns"))
    }

    pub async fn turn(&self, chat_id: &str, turn_id: &str) -> Result<Option<Value>, HarnessError> {
        Ok(self
            .turns(chat_id)
            .await?
            .into_iter()
            .find(|turn| turn_id_of(turn) == Some(turn_id)))
    }

    pub async fn messages(&self, chat_id: &str) -> Result<Vec<Value>, HarnessError> {
        let reply = self.get(&format!("/messages?chat_id={chat_id}")).await?;
        expect_status(&reply, 200, "GET /messages")?;
        Ok(list(reply.data(), "messages"))
    }

    /// Polls `/turns` until the turn reaches a state in `states`.
    pub async fn wait_turn(
        &self,
        chat_id: &str,
        turn_id: &str,
        states: &[&str],
        timeout: Duration,
    ) -> Result<Value, HarnessError> {
        let deadline = Instant::now() + timeout;
        let mut last = Value::Null;
        loop {
            if let Some(turn) = self.turn(chat_id, turn_id).await? {
                if states.contains(&turn_state(&turn)) {
                    return Ok(turn);
                }
                last = turn;
            }
            if Instant::now() > deadline {
                return Err(harness_error(format!(
                    "turn {turn_id} did not reach {states:?} within {timeout:?}; last: {last}"
                )));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    pub async fn wait_terminal(
        &self,
        chat_id: &str,
        turn_id: &str,
        timeout: Duration,
    ) -> Result<Value, HarnessError> {
        self.wait_turn(chat_id, turn_id, TERMINAL, timeout).await
    }

    /// Replays `/events` from `cursor` (the UI's reconnect path).
    pub async fn events_since(&self, cursor: u64) -> Result<Vec<Value>, HarnessError> {
        let mut out = Vec::new();
        let mut cursor = cursor;
        loop {
            let reply = self
                .get(&format!("/events?cursor={cursor}&limit=500"))
                .await?;
            expect_status(&reply, 200, "GET /events")?;
            let events = reply.data()["events"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if events.is_empty() {
                return Ok(out);
            }
            cursor = events
                .last()
                .and_then(|event| event["id"].as_u64())
                .unwrap_or(cursor);
            out.extend(events);
        }
    }
}

pub const TERMINAL: &[&str] = &["delivered", "cancelled", "failed", "runtime_fault"];

pub fn turn_state(turn: &Value) -> &str {
    turn["state"]
        .as_str()
        .or_else(|| turn["status"].as_str())
        .unwrap_or_default()
}

pub fn turn_id_of(turn: &Value) -> Option<&str> {
    turn["turn_id"].as_str().or_else(|| turn["id"].as_str())
}

fn list(data: &Value, key: &str) -> Vec<Value> {
    data.as_array()
        .or_else(|| data[key].as_array())
        .or_else(|| data["items"].as_array())
        .cloned()
        .unwrap_or_default()
}

pub fn expect_status(reply: &Reply, status: u16, what: &str) -> Result<(), HarnessError> {
    if reply.status == status {
        Ok(())
    } else {
        Err(harness_error(format!(
            "{what}: expected {status}, got {}: {}",
            reply.status, reply.text
        )))
    }
}
