//! `set_wallpaper` and `save_wallpaper_module` as reviewed persistent
//! effects, for ask-first Turns: approved like any other effect, then
//! journaled and sent once to the App. Both writes are idempotent, so a
//! dispatch whose outcome was lost is reconciled by sending it again.

use std::sync::Arc;

use serde_json::Value;
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

    /// Sending the same write again is safe and tells what happened.
    fn reconcile<'a>(
        &'a self,
        _: &'a str,
        _: &'a Value,
        _: &'a str,
        signal: &'a CancellationToken,
        _: i64,
        _: Option<&'a butler_turn::btcc::EffectError>,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(self.send(signal))
    }
}
