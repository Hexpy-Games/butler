//! `set_wallpaper` and `save_wallpaper_module` as reviewed persistent
//! effects, for ask-first Turns: approved like any other effect, then
//! journaled and sent once to the App.
//!
//! A dispatch whose outcome was lost is reconciled without overwriting a
//! change made in between. A module save is sent again: its
//! `replace_revision` (or, for a new module, the absence of one) is the
//! expected revision the gateway checks, and the same files again are a
//! no-op. A wallpaper write is never sent again: the current wallpaper is
//! read, and the write counts as applied only when it already shows the
//! requested source; otherwise the outcome stays uncertain for the model to
//! re-check with `list_wallpapers`.

use std::sync::Arc;

use reqwest::Method;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use butler_core::json::JsonDocument;
use butler_turn::btcc::{
    AdapterOutcome, BtccError, EffectAdapter, EffectAdapterError, EffectFailure, EffectFuture,
    ModelRoundToolCall, PlanBinding,
};

use super::super::{
    GuidedTools,
    wallpaper::{self, WallpaperWrite},
};
use crate::host::ActiveAppEndpoint;

pub(super) fn supports(name: &str) -> bool {
    wallpaper::is_write(name)
}

pub(super) fn prepare(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
) -> Result<(String, Value, Arc<dyn EffectAdapter>), BtccError> {
    let request = wallpaper::write_request(call, owner.binding.project_id.as_deref())
        .map_err(|refusal| BtccError::relayed(refusal.code, refusal.message))?;
    let target = request.target.clone();
    let input = request.body.clone();
    let adapter = WallpaperEffect {
        capability: if call.name == butler_core::tool_protocol::ToolName::SaveWallpaperModule {
            "save_wallpaper_module"
        } else {
            "set_wallpaper"
        },
        endpoint: Arc::clone(&owner.app_endpoint),
        request,
    };
    Ok((target, input, Arc::new(adapter)))
}

struct WallpaperEffect {
    capability: &'static str,
    endpoint: Arc<ActiveAppEndpoint>,
    request: WallpaperWrite,
}

impl WallpaperEffect {
    async fn send(&self, signal: &CancellationToken) -> Result<AdapterOutcome, EffectFailure> {
        let reply = wallpaper::send_write(&self.endpoint, &self.request, signal).await;
        let unsent = matches!(&reply, Err(error) if !error.sent);
        let server_error = matches!(&reply, Ok((status, _)) if *status >= 500);
        let result = wallpaper::written(reply);
        if result["ok"] == Value::Bool(true) {
            return JsonDocument::from_value(&result)
                .map(AdapterOutcome::Applied)
                .map_err(|error| EffectFailure::adapter(error.to_string()).with_source(error));
        }
        let error = EffectAdapterError::new(
            result["error"]["code"]
                .as_str()
                .unwrap_or("wallpaper_request_failed"),
            result["error"]["message"]
                .as_str()
                .unwrap_or("The App refused the wallpaper request."),
        );
        Ok(if unsent || !server_error && !is_unknown(&error) {
            AdapterOutcome::NotApplied(error)
        } else {
            AdapterOutcome::Uncertain(Some(error))
        })
    }
}

impl WallpaperEffect {
    /// Reconciles a lost dispatch (see the module docs).
    async fn recover(&self, signal: &CancellationToken) -> Result<AdapterOutcome, EffectFailure> {
        if self.capability == "save_wallpaper_module" {
            return self.send(signal).await;
        }
        let project = self.request.body["project_id"].as_str();
        let query: Vec<_> = project.iter().map(|id| ("project_id", *id)).collect();
        let reply = wallpaper::app_json(&self.endpoint, Method::GET, &query, None, signal).await;
        let current = match &reply {
            Ok((200, body)) if project.is_some() => body["data"]["project"]["wallpaper"].clone(),
            Ok((200, body)) => body["data"]["global"]["source"].clone(),
            _ => Value::Null,
        };
        if shows(&current, &self.request.body["source"]) {
            let result = json!({"ok": true, "recovered": true, "next": current});
            return JsonDocument::from_value(&result)
                .map(AdapterOutcome::Applied)
                .map_err(|error| EffectFailure::adapter(error.to_string()).with_source(error));
        }
        Ok(AdapterOutcome::Uncertain(Some(EffectAdapterError::new(
            "wallpaper_outcome_unknown",
            "The wallpaper change may not have been applied, and the wallpaper may have \
             changed since, so it was not sent again. Call list_wallpapers and set it again \
             if it is still wanted.",
        ))))
    }
}

/// Whether the `current` wallpaper already is the `requested` source: every
/// field the request names has that value (the App completes image options).
/// An attachment's asset is unknown here, so it never matches.
fn shows(current: &Value, requested: &Value) -> bool {
    match (current, requested) {
        (Value::String(current), Value::String(requested)) => current == requested,
        (Value::Object(current), Value::Object(requested)) => {
            requested.get("kind") != Some(&json!("image_from_attachment"))
                && requested
                    .iter()
                    .all(|(key, value)| current.get(key) == Some(value))
        }
        _ => false,
    }
}

/// The request reached the App but its answer was lost.
fn is_unknown(error: &EffectAdapterError) -> bool {
    matches!(
        error.code.as_str(),
        "wallpaper_outcome_unknown" | "wallpaper_response_invalid"
    )
}

impl EffectAdapter for WallpaperEffect {
    fn capability(&self) -> &str {
        self.capability
    }

    fn binding(&self) -> PlanBinding {
        PlanBinding::AcceptedPlan
    }

    fn normalize_target(&self, target: &str) -> Result<String, EffectFailure> {
        if target == self.request.target {
            Ok(target.to_owned())
        } else {
            Err(EffectFailure::policy(
                "wallpaper_target_invalid".to_owned(),
                "Wallpaper effect target is invalid.",
            ))
        }
    }

    fn sanitize_target(&self, target: &str) -> Result<String, EffectFailure> {
        self.normalize_target(target)
    }

    fn normalize_input(&self, input: &Value) -> Result<Value, EffectFailure> {
        if *input == self.request.body {
            Ok(input.clone())
        } else {
            Err(EffectFailure::policy(
                "wallpaper_input_invalid".to_owned(),
                "Wallpaper effect input is invalid.",
            ))
        }
    }

    fn dispatch<'a>(
        &'a self,
        _: &'a str,
        _: &'a Value,
        _: &'a str,
        signal: &'a CancellationToken,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(self.send(signal))
    }

    /// Recovers without overwriting a change made in between.
    fn reconcile<'a>(
        &'a self,
        _: &'a str,
        _: &'a Value,
        _: &'a str,
        signal: &'a CancellationToken,
        _: i64,
        _: Option<&'a butler_turn::btcc::EffectError>,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(self.recover(signal))
    }
}
