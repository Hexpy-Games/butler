use super::*;
use butler_models::mcp_client::ConnectorSession;
use std::time::{Duration, Instant};
impl Connectors {
    pub(super) async fn run(
        self: Arc<Self>,
        account: Account,
        definition: Connector,
        mut calls: mpsc::Receiver<Call>,
        cancel: CancellationToken,
    ) {
        let (events, consumer, delivery) = self.workers(&account, &definition, &cancel);
        let mut exits = std::collections::VecDeque::new();
        while !cancel.is_cancelled() {
            self.status(
                &account.id,
                if exits.is_empty() {
                    "connecting"
                } else {
                    "reconnecting"
                },
                None,
            );
            let connect = async {
                let prepared = self.prepared(&account, &definition.events.server).await?;
                ConnectorSession::open(prepared, &std::env::vars().collect())
                    .await
                    .map_err(error)
            };
            let connected = tokio::select! {()=cancel.cancelled()=>break, r=tokio::time::timeout(Duration::from_secs(10),connect)=>r.map_err(|_|error("connector_connect_timeout")).and_then(|r|r)};
            let result = match connected {
                Ok(mut session) => {
                    let result = self
                        .drive(
                            &account,
                            &definition,
                            &mut session,
                            &mut calls,
                            &events,
                            &cancel,
                        )
                        .await;
                    session.close().await;
                    result
                }
                Err(e) => Err(e),
            };
            if cancel.is_cancelled() {
                break;
            }
            let now = Instant::now();
            while exits
                .front()
                .is_some_and(|t| now.duration_since(*t) > Duration::from_secs(300))
            {
                exits.pop_front();
            }
            exits.push_back(now);
            if exits.len() >= 3 {
                self.status(&account.id, "crashed", Some("connector_crash_limit"));
                break;
            }
            self.status(&account.id, "reconnecting", result.err().map(|e| e.code));
        }
        if !cancel.is_cancelled() {
            cancel.cancelled().await;
        }
        drop(events);
        delivery.abort();
        let _ = consumer.await;
        let _ = delivery.await;
    }
    fn workers(
        self: &Arc<Self>,
        account: &Account,
        definition: &Connector,
        cancel: &CancellationToken,
    ) -> (mpsc::UnboundedSender<Value>, JoinHandle<()>, JoinHandle<()>) {
        let (events, mut intake) = mpsc::unbounded_channel();
        let runtime = self.clone();
        let a = account.clone();
        let d = definition.clone();
        let pending = Arc::new(tokio::sync::Notify::new());
        let wake = pending.clone();
        let consumer = tokio::spawn(async move {
            if let Ok(rows) = runtime.storage("unfinished", json!({"account":a.id})).await {
                for event in rows["rows"].as_array().into_iter().flatten() {
                    if let Err(e) = runtime.ingest(&a, &d, event.clone()).await {
                        runtime.status(&a.id, "connected", Some(e.code));
                    }
                }
                wake.notify_one();
            }
            while let Some(event) = intake.recv().await {
                if let Err(e) = runtime.ingest(&a, &d, event).await {
                    runtime.status(&a.id, "connected", Some(e.code));
                }
                wake.notify_one();
            }
        });
        let runtime = self.clone();
        let a = account.clone();
        let stop = cancel.clone();
        let delivery = tokio::spawn(async move {
            runtime.deliver(a, pending, stop).await;
        });
        (events, consumer, delivery)
    }
    async fn drive(
        &self,
        account: &Account,
        definition: &Connector,
        session: &mut ConnectorSession,
        calls: &mut mpsc::Receiver<Call>,
        events: &mpsc::UnboundedSender<Value>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        if let Some(dest) = &definition.destinations {
            let value = session.read(&dest.resource).await.map_err(error)?;
            let mut statuses = self.states.lock();
            if let Some(s) = statuses.get_mut(&account.id) {
                s.destinations = value;
            }
        }
        self.status(&account.id, "connected", None);
        loop {
            tokio::select! {
                ()=cancel.cancelled()=>return Ok(()),
                value=session.changed()=> {
                    value.map_err(error)?;
                    let value=tokio::time::timeout(Duration::from_secs(10),session.read("connector://events")).await
                        .map_err(|_|error("connector_read_timeout"))?.map_err(error)?;
                    let values=value["events"].as_array().ok_or_else(||error("connector_events_invalid"))?;
                    for event in values {events.send(event.clone()).map_err(|_|error("connector_intake_closed"))?;}
                }
                call=calls.recv()=> {
                    let Some(call)=call else {return Ok(())};
                    let result=tokio::select! {
                        ()=cancel.cancelled()=>Err(error("connector_disconnected")),
                        r=tokio::time::timeout(Duration::from_secs(10),session.call(&call.tool,call.args))=>r.map_err(|_|error("connector_tool_timeout")).and_then(|r|r.map_err(error))
                    };
                    let _=call.response.send(result);
                }
            }
        }
    }
    async fn deliver(
        &self,
        account: Account,
        pending: Arc<tokio::sync::Notify>,
        cancel: CancellationToken,
    ) {
        pending.notify_one();
        loop {
            tokio::select! {()=cancel.cancelled()=>return,()=pending.notified()=>()}
            let mut window: Option<(String, Instant)> = None;
            loop {
                let batch = match self.storage("pending", json!({"account":account.id})).await {
                    Ok(batch) => batch,
                    Err(e) => {
                        self.status(&account.id, "connected", Some(e.code));
                        break;
                    }
                };
                let Some(rows) = batch["rows"].as_array().filter(|r| !r.is_empty()) else {
                    break;
                };
                let batch_only = rows.iter().all(|r| r["skip_model"] == true);
                if account.handling.mode == "batch" || batch_only {
                    let first = rows[0]["event_id"].as_str().unwrap_or_default();
                    if window.as_ref().is_none_or(|(id, _)| id != first) {
                        window =
                            Some((first.into(), Instant::now() + batch_wait(&account, &batch)));
                    }
                    let wait = window
                        .as_ref()
                        .map(|(_, end)| end.saturating_duration_since(Instant::now()))
                        .unwrap_or_default();
                    if !wait.is_zero() {
                        tokio::select! {
                            ()=cancel.cancelled()=>return,
                            ()=pending.notified()=>continue,
                            ()=tokio::time::sleep(wait)=>()
                        }
                    }
                }
                let result = tokio::select! {()=cancel.cancelled()=>return,r=self.storage("deliver",json!({"account":account.id}))=>r};
                window = None;
                if let Err(e) = result {
                    self.status(&account.id, "connected", Some(e.code));
                    break;
                }
            }
        }
    }
}

fn batch_wait(account: &Account, pending: &Value) -> Duration {
    let parsed = |v: &Value| {
        v.as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
    };
    let elapsed = parsed(&pending["now"])
        .zip(parsed(&pending["rows"][0]["arrived_at"]))
        .map(|(now, arrival)| (now - arrival).num_milliseconds().max(0) as f64 / 1000.0)
        .unwrap_or_default();
    Duration::from_secs_f64((account.handling.interval_minutes * 60.0 - elapsed).max(0.0))
}
