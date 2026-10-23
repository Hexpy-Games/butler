//! Stream indexed activity candidates until the requested visible page is full.
use super::super::{AppApplication, app_error};
use super::{AppWorkerActivityQuery, append_relation_workers, encode_activity_cursor, sessions};
use crate::gateway::{AppSessionSummary, GatewayApplicationError};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use std::collections::HashMap;

pub(in crate::gateway::application) fn read_owned(
    app: AppApplication,
    query: AppWorkerActivityQuery,
) -> crate::gateway::ApplicationFuture<Option<Value>> {
    Box::pin(async move { read(&app, query).await })
}

async fn read(
    app: &AppApplication,
    query: AppWorkerActivityQuery,
) -> Result<Option<Value>, GatewayApplicationError> {
    let requested = query.session_id.clone().filter(|id| !id.is_empty());
    let parent = if let Some(id) = &requested {
        let id = id.clone();
        let found = app
            .storage
            .execute(move |db| sessions::resolve(db, &[id]))
            .await
            .map_err(app_error)?;
        let Some(session) = found.first() else {
            return Ok(Some(Page::new(&query).finish()));
        };
        Some(session.session_hint.clone())
    } else {
        None
    };
    let mut page = Page::new(&query);
    if let Some(worker) = page.wanted_cursor.clone()
        && let Some(parents) = app
            .dependencies
            .subsessions
            .activity_cursor_parents(worker, query.include_history, parent.clone())
            .await?
    {
        let visible = app
            .storage
            .execute(move |db| sessions::resolve(db, &parents))
            .await
            .map_err(app_error)?;
        if visible.is_empty() {
            page.cursor_found = true;
        }
    }
    let mut after = None;
    let mut catalog = HashMap::new();
    loop {
        let Some(batch) = app
            .dependencies
            .subsessions
            .activity_page(
                query.include_history,
                after,
                parent.clone(),
                page.remaining(),
            )
            .await?
        else {
            return Ok(None);
        };
        let exhausted = batch.after.is_none();
        for child in batch.children {
            for worker in workers(app, &child, &mut catalog, requested.as_deref()).await? {
                page.observe(worker);
                if page.complete() {
                    return Ok(Some(page.finish()));
                }
            }
        }
        if exhausted {
            break;
        }
        after = batch.after;
    }
    Ok(Some(page.finish()))
}

async fn workers(
    app: &AppApplication,
    child: &Value,
    catalog: &mut HashMap<String, Vec<AppSessionSummary>>,
    requested: Option<&str>,
) -> Result<Vec<Value>, GatewayApplicationError> {
    let Some(parent) = child
        .pointer("/relation/parent_session_id")
        .and_then(Value::as_str)
    else {
        return Ok(Vec::new());
    };
    if !catalog.contains_key(parent) {
        let id = parent.to_owned();
        let sessions = app
            .storage
            .execute(move |db| sessions::resolve(db, &[id]))
            .await
            .map_err(app_error)?;
        catalog.insert(parent.to_owned(), sessions);
    }
    let role = child["role"].as_str().unwrap_or("worker");
    let projection = json!({"children":[child]});
    let mut output = Vec::new();
    for session in &catalog[parent] {
        if requested.is_some_and(|id| id != session.id && id != session.session_hint) {
            continue;
        }
        append_relation_workers(&mut output, &projection, session, "children", role, true);
    }
    Ok(output)
}

struct Page {
    limit: usize,
    offset: usize,
    seen: usize,
    wanted_cursor: Option<String>,
    cursor_found: bool,
    items: Vec<Value>,
    fallback: Vec<Value>,
}
impl Page {
    fn new(query: &AppWorkerActivityQuery) -> Self {
        let wanted_cursor = query
            .cursor
            .as_deref()
            .and_then(|cursor| URL_SAFE_NO_PAD.decode(cursor).ok())
            .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
            .filter(|value| value["v"] == 1)
            .and_then(|value| value["worker_id"].as_str().map(str::to_owned));
        Self {
            limit: query.limit.unwrap_or(200).clamp(1, 200),
            offset: query.offset.unwrap_or(0),
            seen: 0,
            cursor_found: wanted_cursor.is_none(),
            wanted_cursor,
            items: Vec::new(),
            fallback: Vec::new(),
        }
    }
    fn observe(&mut self, worker: Value) {
        if !self.cursor_found {
            if self.seen >= self.offset && self.fallback.len() <= self.limit {
                self.fallback.push(worker.clone());
            }
            if worker["worker_id"].as_str() == self.wanted_cursor.as_deref() {
                self.cursor_found = true;
                self.offset = self.seen.saturating_add(1);
            }
        } else if self.seen >= self.offset && self.items.len() <= self.limit {
            self.items.push(worker);
        }
        self.seen = self.seen.saturating_add(1);
    }
    fn remaining(&self) -> usize {
        if !self.cursor_found || self.seen < self.offset {
            200
        } else {
            (self.limit + 1 - self.items.len()).clamp(1, 200)
        }
    }
    fn complete(&self) -> bool {
        self.cursor_found && self.items.len() > self.limit
    }
    fn finish(mut self) -> Value {
        if !self.cursor_found {
            self.items = self.fallback;
        }
        let has_more = self.items.len() > self.limit;
        self.items.truncate(self.limit);
        let mut pagination = json!({"limit":self.limit,"offset":self.offset,"has_more":has_more});
        if has_more
            && let Some(id) = self
                .items
                .last()
                .and_then(|worker| worker["worker_id"].as_str())
        {
            pagination["next_cursor"] = json!(encode_activity_cursor(id));
        }
        json!({"workers":self.items,"pagination":pagination})
    }
}
