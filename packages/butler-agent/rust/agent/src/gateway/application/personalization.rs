use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use crate::gateway::{ApplicationFuture, GatewayApplicationError};

pub(crate) enum AppPersonalizationCommand {
    Read { locale: String },
    Prompt { locale: String },
    Update { input: Value },
    Import { input: Value, locale: String },
}

pub(crate) struct AppPersonalizationEvent {
    pub event_type: String,
    pub payload: Map<String, Value>,
}

pub(crate) struct AppPersonalizationResult {
    pub data: Value,
    pub event: Option<AppPersonalizationEvent>,
}

pub(crate) trait AppPersonalizationPort: Send + Sync + 'static {
    fn execute(
        &self,
        command: AppPersonalizationCommand,
        cancellation: CancellationToken,
    ) -> ApplicationFuture<AppPersonalizationResult>;
}

impl super::AppApplication {
    pub(super) async fn personalization_owned(
        &self,
        command: AppPersonalizationCommand,
        cancellation: CancellationToken,
    ) -> Result<Value, GatewayApplicationError> {
        let locale = match &command {
            AppPersonalizationCommand::Prompt { locale } => locale.clone(),
            AppPersonalizationCommand::Read { .. }
            | AppPersonalizationCommand::Update { .. }
            | AppPersonalizationCommand::Import { .. } => self.briefing_language().await?,
        };
        let (port_command, after_event) = match command {
            AppPersonalizationCommand::Prompt { locale } => {
                (AppPersonalizationCommand::Prompt { locale }, false)
            }
            AppPersonalizationCommand::Read { .. } => (
                AppPersonalizationCommand::Read {
                    locale: locale.clone(),
                },
                false,
            ),
            AppPersonalizationCommand::Update { input } => {
                (AppPersonalizationCommand::Update { input }, true)
            }
            AppPersonalizationCommand::Import { input, .. } => (
                AppPersonalizationCommand::Import {
                    input,
                    locale: locale.clone(),
                },
                true,
            ),
        };
        let result = self
            .dependencies
            .personalization
            .execute(port_command, cancellation)
            .await?;
        if let Some(event) = result.event {
            let subscribers = self.subscribers.clone();
            let event_type = event.event_type;
            let payload = event.payload;
            let now = self.dependencies.identity_clock.now_iso();
            self.storage
                .execute(move |db| {
                    super::events::append(db, &subscribers, &event_type, None, payload, &now)
                        .map(|_| ())
                })
                .await
                .map_err(super::app_error)?;
        }
        if !after_event {
            return Ok(result.data);
        }
        let fresh = self
            .dependencies
            .personalization
            .execute(
                AppPersonalizationCommand::Read { locale },
                CancellationToken::new(),
            )
            .await?
            .data;
        match result.data {
            Value::Object(mut object) if object.contains_key("personalization") => {
                object.insert("personalization".into(), fresh);
                Ok(Value::Object(object))
            }
            _ => Ok(fresh),
        }
    }
}
