use super::{AppSetupPort, Computer, HttpError, relay, store};
use butler_models::models::{EnvError, check_computer_environment};
use butler_platform::secrets::SecretText;
use std::{collections::BTreeMap, path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct EnvInput {
    name: String,
    value: Option<String>,
}

pub(super) fn merge(
    stored: &BTreeMap<String, SecretText>,
    input: Vec<EnvInput>,
) -> Result<BTreeMap<String, SecretText>, HttpError> {
    // Resolve absent values before checking the total launch size.
    check_computer_environment(input.iter().map(|entry| {
        let value = entry
            .value
            .as_deref()
            .or_else(|| stored.get(&entry.name).map(SecretText::expose));
        (entry.name.as_str(), value)
    }))
    .map_err(|error| invalid(&error))?;
    Ok(input
        .into_iter()
        .map(|EnvInput { name, value }| {
            let secret = value
                .map(SecretText::new)
                .unwrap_or_else(|| SecretText::new(stored[&name].expose().to_owned()));
            (name, secret)
        })
        .collect())
}

pub(in crate::gateway) fn invalid(error: &EnvError) -> HttpError {
    HttpError::public(400, error.code(), &error.to_string())
}

pub(super) async fn push(
    setup: &Arc<dyn AppSetupPort>,
    root: &Path,
    computer: &Computer,
    cancel: CancellationToken,
) -> Result<(), HttpError> {
    let values = setup.computer_environment(computer.id.clone()).await?;
    let variables: BTreeMap<_, _> = values
        .iter()
        .map(|(name, value)| (name, value.expose()))
        .collect();
    let body = serde_json::json!({ "variables": variables })
        .to_string()
        .into_bytes();
    let mut sent = relay::send(
        computer,
        "POST",
        "/remote/environment",
        body.clone(),
        cancel.clone(),
    )
    .await?;
    if matches!(&sent, relay::Sent::Reply(reply)
        if reply.status == 409 && reply.body["error"]["code"] == "remote_key_pending")
    {
        let identity = setup.computer_key(computer.id.clone()).await?;
        relay::unlock(computer, &identity, cancel.clone()).await?;
        sent = relay::send(computer, "POST", "/remote/environment", body, cancel).await?;
    }
    match sent {
        relay::Sent::NotRunning => Ok(()),
        relay::Sent::Reply(reply) => match reply.status {
            204 => {
                let sent_environment = !values.is_empty();
                store::update(
                    root.join("config/computers.json"),
                    computer.id.clone(),
                    move |c| {
                        c.sent_environment = sent_environment;
                    },
                )
                .await?;
                Ok(())
            }
            404 => {
                butler_core::diagnostic!("[remote-env] remote too old computer={}", computer.id);
                Ok(())
            }
            _ => Err(relay::data(reply).err().unwrap_or(HttpError::Internal)),
        },
    }
}
