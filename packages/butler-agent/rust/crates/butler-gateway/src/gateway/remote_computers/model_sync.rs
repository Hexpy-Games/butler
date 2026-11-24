use super::{AppSetupPort, Computer, HttpError, relay, remote_error, store};
use butler_models::models::{ComputerModel, RegisteredHostedModelConfig};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(in crate::gateway) enum ModelSource {
    #[default]
    None,
    Follow,
    Chatgpt,
    Key(String),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::gateway) struct ModelInput {
    pub model_source: ModelSource,
    #[serde(default)]
    pub open_sign_in: bool,
}

pub(in crate::gateway) async fn update(
    setup: &Arc<dyn AppSetupPort>,
    root: &Path,
    path: &str,
    version: &str,
    input: ModelInput,
    cancel: CancellationToken,
) -> Result<Computer, HttpError> {
    let id = path
        .strip_prefix("/computers/")
        .filter(|id| !id.is_empty() && !id.contains('/'))
        .ok_or_else(|| HttpError::public(404, "not_found", "Route not found."))?;
    let source = input.model_source;
    if let ModelSource::Key(id) = &source {
        setup.computer_model(Some(id.clone())).await?;
    }
    let (_lock, _) = super::locked(root, id).await?;
    let computer = store::update(
        root.join("config/computers.json"),
        id.to_owned(),
        move |c| {
            c.model_source = source;
        },
    )
    .await?;
    if matches!(
        computer.model_source,
        ModelSource::Follow | ModelSource::Key(_)
    ) {
        let (_, sync) = super::connect(setup, root, version, &computer, cancel).await?;
        sync?;
    }
    super::list(root)
        .await?
        .into_iter()
        .find(|computer| computer.id == id)
        .ok_or_else(|| HttpError::public(404, "computer_not_found", "Computer not found."))
}

async fn plan(
    setup: &Arc<dyn AppSetupPort>,
    source: &ModelSource,
) -> Result<ComputerModel, HttpError> {
    Ok(match source {
        ModelSource::Follow => setup.computer_model(None).await?,
        ModelSource::Key(id) => setup.computer_model(Some(id.clone())).await?,
        ModelSource::Chatgpt | ModelSource::None => ComputerModel::None,
    })
}

async fn send(
    setup: &Arc<dyn AppSetupPort>,
    computer: &Computer,
    plan: ComputerModel,
    cancel: CancellationToken,
) -> Result<Option<String>, HttpError> {
    let ComputerModel::Key {
        credential_id,
        model,
    } = plan
    else {
        return Ok(computer.sent_credential.clone());
    };
    let key = setup.saved_provider_key(credential_id).await?;
    let body = json!({"provider_id": key.provider_id, "api_key": key.api_key.expose()});
    let saved = relay::data(
        relay::request(
            computer,
            "POST",
            "/credentials",
            body.to_string().into_bytes(),
            cancel.clone(),
        )
        .await?,
    )?;
    let remote_id = saved["credential"]["id"]
        .as_str()
        .ok_or(HttpError::Internal)?;
    let created = saved["created"].as_bool().ok_or(HttpError::Internal)?;
    let applied = match model.as_deref() {
        Some(model) => apply_model(computer, model, remote_id, cancel.clone()).await,
        None => Ok(()),
    };
    let previous = computer.sent_credential.as_deref();
    let remove = if applied.is_err() {
        created.then_some(remote_id)
    } else {
        previous.filter(|prev| *prev != remote_id)
    };
    if let Some(id) = remove
        && !relay::request(
            computer,
            "DELETE",
            &format!("/credentials/{id}?force=true"),
            Vec::new(),
            cancel,
        )
        .await
        .is_ok_and(|reply| matches!(reply.status, 200 | 404))
    {
        if applied.is_err() {
            butler_core::diagnostic!(
                "[remote-model] new key not removed computer={}",
                computer.id
            );
        } else {
            butler_core::diagnostic!(
                "[remote-model] old key not removed computer={}",
                computer.id
            );
        }
    }
    applied?;
    Ok((created || previous == Some(remote_id)).then(|| remote_id.to_owned()))
}

async fn apply_model(
    computer: &Computer,
    model: &RegisteredHostedModelConfig,
    remote_id: &str,
    cancel: CancellationToken,
) -> Result<(), HttpError> {
    let body = json!({
        "provider_id": model.provider_id, "model_id": model.model_id,
        "auth_type": "api_key", "credential_id": remote_id,
    });
    relay::data(
        relay::request(
            computer,
            "POST",
            "/model-catalog/registered-models",
            body.to_string().into_bytes(),
            cancel.clone(),
        )
        .await?,
    )?;
    let body = json!({"model": model.model_ref});
    relay::data(
        relay::request(
            computer,
            "PATCH",
            "/settings",
            body.to_string().into_bytes(),
            cancel,
        )
        .await?,
    )?;
    Ok(())
}

async fn remote_connected(
    computer: &Computer,
    cancel: CancellationToken,
) -> Result<bool, HttpError> {
    let credentials = relay::request(computer, "GET", "/credentials", Vec::new(), cancel.clone())
        .await
        .and_then(relay::data);
    if credentials.as_ref().is_ok_and(|data| {
        data["credentials"]
            .as_array()
            .is_some_and(|keys| !keys.is_empty())
    }) {
        return Ok(true);
    }
    let chatgpt = relay::request(
        computer,
        "GET",
        "/setup/chatgpt-account",
        Vec::new(),
        cancel,
    )
    .await;
    credentials?;
    Ok(relay::data(chatgpt?)?["status"] == "signed_in")
}

pub(super) async fn sync(
    setup: &Arc<dyn AppSetupPort>,
    root: &Path,
    computer: &Computer,
    cancel: CancellationToken,
) -> Result<(), HttpError> {
    let (sent, accepted_key) = match plan(setup, &computer.model_source).await {
        Ok(plan) => {
            let key_plan = matches!(plan, ComputerModel::Key { .. });
            let sent = send(setup, computer, plan, cancel.clone()).await;
            let accepted_key = key_plan && sent.is_ok();
            (sent, accepted_key)
        }
        Err(error) => (Err(error), false),
    };
    let connected = if accepted_key {
        Some(true)
    } else {
        remote_connected(computer, cancel).await.ok()
    };
    let failed = sent.is_err();
    store::update(
        root.join("config/computers.json"),
        computer.id.clone(),
        move |c| {
            if let Ok(sent) = sent {
                c.sent_credential = sent;
            }
            if let Some(connected) = connected {
                c.ai_connected = connected;
            }
        },
    )
    .await?;
    if failed {
        return Err(remote_error(
            "remote_model_sync_failed",
            "Could not send the model to this computer.",
        ));
    }
    Ok(())
}
