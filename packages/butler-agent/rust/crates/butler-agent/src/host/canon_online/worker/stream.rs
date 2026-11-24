//! The HTTP side of a worker: flush the queue, pull the stream, resync.
//! At most one batch per space is in flight: each POST and its results are
//! recorded before the next batch is taken.
use super::*;
use butler_canon::store::sync::Applied;

impl Worker {
    /// A GET whose status maps to the shared outcomes; 429/503 wait and retry.
    async fn get(&mut self, pass: &Pass, path: &str) -> Result<Value, Outcome> {
        loop {
            let response = self
                .online
                .account
                .canon_raw(&pass.token, Method::GET, path, None)
                .await;
            match response {
                Err(_) => return Err(Outcome::Reconnect),
                Ok((200, _, body)) => return Ok(body),
                Ok((status, retry, body)) => self.refused(status, retry, &body).await?,
            }
        }
    }
    /// Non-200 answers: `Ok(())` means wait was served and the call repeats.
    async fn refused(
        &mut self,
        status: u16,
        retry: Option<u64>,
        body: &Value,
    ) -> Result<(), Outcome> {
        match status {
            401 => Err(Outcome::SignedOut),
            404 => {
                self.detach().await;
                Err(Outcome::Detached)
            }
            429 | 503 => match self.pause(retry_after(retry)).await {
                Pause::Elapsed => Ok(()),
                Pause::Wake => Err(Outcome::Wake),
                Pause::Cancelled => Err(Outcome::Cancelled),
            },
            _ => {
                tracing::error!(
                    status,
                    code = body["error"]["code"].as_str().unwrap_or_default(),
                    message = body["error"]["message"].as_str().unwrap_or_default(),
                    "Canon online request refused"
                );
                Err(Outcome::Stopped)
            }
        }
    }
    /// Members at pass start: 404 detaches, 401 signs out, anything else retries.
    pub(super) async fn members(&mut self, pass: &Pass) -> Result<Value, Outcome> {
        let path = format!("{}/members", self.path);
        match self
            .online
            .account
            .canon_raw(&pass.token, Method::GET, &path, None)
            .await
        {
            Ok((200, _, body)) => Ok(body),
            Ok((401, _, _)) => Err(Outcome::SignedOut),
            Ok((404, _, _)) => {
                self.detach().await;
                Err(Outcome::Detached)
            }
            _ => Err(Outcome::Reconnect),
        }
    }

    pub(super) async fn ensure_resync(&mut self, pass: &Pass) -> Outcome {
        let link = match self.link().await {
            Ok(Some(link)) => link,
            Ok(None) => return Outcome::Detached,
            Err(outcome) => return outcome,
        };
        if link["resync_pending"] != 1 {
            return Outcome::Done;
        }
        let snapshot = match self.get(pass, &format!("{}/snapshot", self.path)).await {
            Ok(snapshot) => snapshot,
            Err(outcome) => return outcome,
        };
        let (me, space) = (Self::me(pass), self.space.clone());
        let resynced = self
            .online
            .storage
            .canon_write(move |tx| sync::resync(tx, &me, &space, &snapshot))
            .await;
        match resynced {
            Ok(Some(skipped)) => {
                if !skipped.is_empty() {
                    tracing::warn!(?skipped, "Canon online resync skipped entities");
                }
                Outcome::Done
            }
            Ok(None) => Outcome::Detached,
            Err(_) => Outcome::Reconnect,
        }
    }

    pub(super) async fn flush_if_sendable(&mut self, pass: &mut Pass) -> Outcome {
        let space = self.space.clone();
        match self
            .online
            .storage
            .canon_read(move |db| sync::has_sendable(db, &space))
            .await
        {
            Ok(true) => self.flush(pass).await,
            Ok(false) => Outcome::Done,
            Err(_) => Outcome::Reconnect,
        }
    }

    pub(super) async fn flush(&mut self, pass: &mut Pass) -> Outcome {
        let outcome = self.ensure_resync(pass).await;
        if !matches!(outcome, Outcome::Done) {
            return outcome;
        }
        loop {
            let space = self.space.clone();
            let rows = match self
                .online
                .storage
                .canon_write(move |tx| sync::take_sendable(tx, &space))
                .await
            {
                Ok(rows) if rows.is_empty() => return Outcome::Done,
                Ok(rows) => rows,
                Err(_) => return Outcome::Reconnect,
            };
            let (path, body) = (format!("{}/ops", self.path), json!({"ops": rows}));
            let results = loop {
                let response = self
                    .online
                    .account
                    .canon_raw(&pass.token, Method::POST, &path, Some(body.clone()))
                    .await;
                match response {
                    Err(_) => return Outcome::Reconnect,
                    Ok((200, _, answer)) => break answer["results"].clone(),
                    Ok((403, _, answer)) if answer["error"]["code"] == "canon_forbidden" => {
                        return self.demote(pass).await;
                    }
                    Ok((status, retry, answer)) => {
                        if let Err(outcome) = self.refused(status, retry, &answer).await {
                            return outcome;
                        }
                    }
                }
            };
            let (me, space) = (Self::me(pass), self.space.clone());
            let results = results.as_array().cloned().unwrap_or_default();
            let Ok(recorded) = self
                .online
                .storage
                .canon_write(move |tx| sync::record_results(tx, &me, &space, &results))
                .await
            else {
                return Outcome::Reconnect;
            };
            for op_id in &recorded.failed {
                tracing::warn!(
                    op_id,
                    "Canon online op failed locally; its queued changes were dropped"
                );
            }
            if recorded.accepted {
                let outcome = self.pull(pass).await;
                if !matches!(outcome, Outcome::Done) {
                    return outcome;
                }
            }
        }
    }
    /// 403 `canon_forbidden`: this account is a viewer now. Never resend.
    async fn demote(&mut self, pass: &Pass) -> Outcome {
        let space = self.space.clone();
        match self
            .online
            .storage
            .canon_write(move |tx| sync::demote(tx, &space))
            .await
        {
            Ok(dropped) => {
                tracing::warn!(dropped, "viewer: dropped queued changes");
                self.ensure_resync(pass).await
            }
            Err(_) => Outcome::Reconnect,
        }
    }

    pub(super) async fn pull(&mut self, pass: &mut Pass) -> Outcome {
        let outcome = self.ensure_resync(pass).await;
        if !matches!(outcome, Outcome::Done) {
            return outcome;
        }
        let mut cursor = match self.link().await {
            Ok(Some(link)) => link["cursor_seq"].as_i64().unwrap_or_default(),
            Ok(None) => return Outcome::Detached,
            Err(outcome) => return outcome,
        };
        loop {
            let path = format!("{}/ops?after={cursor}&limit=500", self.path);
            let body = match self.get(pass, &path).await {
                Ok(body) => body,
                Err(outcome) => return outcome,
            };
            if body["resync"] == true {
                let space = self.space.clone();
                let marked = self
                    .online
                    .storage
                    .canon_write(move |tx| sync::mark_resync(tx, &space))
                    .await;
                if marked.is_err() {
                    return Outcome::Reconnect;
                }
                return self.ensure_resync(pass).await;
            }
            let ops = body["ops"].as_array().cloned().unwrap_or_default();
            let applied = match self.apply(pass, ops).await {
                Ok(applied) => applied,
                Err(outcome) => return outcome,
            };
            if body["more"] != true || applied.gap {
                return Outcome::Done;
            }
            cursor = applied.cursor;
        }
    }
    /// Applies stream records; an unknown author refreshes the members once.
    pub(super) async fn apply(
        &mut self,
        pass: &mut Pass,
        ops: Vec<Value>,
    ) -> Result<Applied, Outcome> {
        if ops.iter().any(|op| {
            op["account_id"]
                .as_str()
                .is_some_and(|account| !pass.members.contains_key(account))
        }) && let Ok(members) = self.members(pass).await
        {
            pass.members = email_map(&members);
        }
        let (members, space) = (pass.members.clone(), self.space.clone());
        let now = chrono::Utc::now().timestamp_millis();
        let applied = self
            .online
            .storage
            .canon_write(move |tx| sync::apply(tx, &space, &ops, &members, now))
            .await
            .map_err(|_| Outcome::Reconnect)?;
        if applied.missing {
            return Err(Outcome::Detached);
        }
        for op_id in &applied.skipped {
            tracing::warn!(op_id, "Canon online op skipped");
        }
        Ok(applied)
    }
}
