use super::{AppSetupPort, Computer, HttpError, relay, store};
use butler_models::models::{EnvError, check_computer_environment, parse_computer_environment};
use butler_platform::secrets::SecretText;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct EnvInput {
    name: String,
    value: Option<String>,
}

type Secrets = BTreeMap<String, SecretText>;

fn merge(stored: &Secrets, input: Vec<EnvInput>) -> Result<Secrets, HttpError> {
    check_computer_environment(input.iter().map(|entry| {
        (
            entry.name.as_str(),
            secret_value(stored, entry).unwrap_or_default(),
        )
    }))
    .map_err(|error| invalid(&error))?;
    input
        .into_iter()
        .map(|EnvInput { name, value }| {
            let value = value
                .or_else(|| stored.get(&name).map(|secret| secret.expose().to_owned()))
                .filter(|value| !value.is_empty())
                .ok_or_else(|| invalid(&EnvError::ValueRequired))?;
            Ok((name, SecretText::new(value)))
        })
        .collect()
}

fn secret_value<'a>(stored: &'a Secrets, entry: &'a EnvInput) -> Option<&'a str> {
    entry
        .value
        .as_deref()
        .or_else(|| stored.get(&entry.name).map(SecretText::expose))
}

pub(super) struct Edit {
    pub names: Option<Vec<String>>,
    pub changed_secrets: Option<(Secrets, Secrets)>,
}

pub(super) async fn prepare(
    setup: &Arc<dyn AppSetupPort>,
    computer: &Computer,
    text: &str,
    input: Option<Vec<EnvInput>>,
) -> Result<Edit, HttpError> {
    let names = input.as_ref().map_or_else(
        || computer.environment.iter().map(String::as_str).collect(),
        |rows| rows.iter().map(|row| row.name.as_str()).collect(),
    );
    let variables = parse(text, &names)?;
    let previous = read_secrets(setup, computer).await?;
    let next = input.map(|rows| merge(&previous, rows)).transpose()?;
    validate_budget(variables, next.as_ref().unwrap_or(&previous))?;
    let names = next.as_ref().map(|next| next.keys().cloned().collect());
    let changed_secrets = next.filter(|next| !exposed(&previous).eq(exposed(next)));
    Ok(Edit {
        names,
        changed_secrets: changed_secrets.map(|next| (previous, next)),
    })
}

pub(super) fn prepare_add(text: &str, input: Vec<EnvInput>) -> Result<Secrets, HttpError> {
    let names = input.iter().map(|row| row.name.as_str()).collect();
    let variables = parse(text, &names)?;
    let secrets = merge(&Default::default(), input)?;
    validate_budget(variables, &secrets)?;
    Ok(secrets)
}

fn parse<'a>(
    text: &'a str,
    names: &BTreeSet<&str>,
) -> Result<BTreeMap<&'a str, &'a str>, HttpError> {
    parse_computer_environment(text, names).map_err(|(error, line)| match line {
        Some(line) => HttpError::InvalidLine {
            code: error.code(),
            message: format!("Line {line}: {error}"),
            line,
        },
        None => invalid(&error),
    })
}

fn exposed(secrets: &Secrets) -> impl ExactSizeIterator<Item = (&str, &str)> {
    secrets
        .iter()
        .map(|(name, value)| (name.as_str(), value.expose()))
}

fn validate_budget(variables: BTreeMap<&str, &str>, secrets: &Secrets) -> Result<(), HttpError> {
    let entries: Vec<_> = variables.into_iter().chain(exposed(secrets)).collect();
    check_computer_environment(entries.into_iter()).map_err(|error| invalid(&error))
}

async fn read_secrets(
    setup: &Arc<dyn AppSetupPort>,
    computer: &Computer,
) -> Result<Secrets, HttpError> {
    if computer.environment.is_empty() {
        return Ok(BTreeMap::new());
    }
    Ok(setup.computer_environment(computer.id.clone()).await?)
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
    let secrets = read_secrets(setup, computer).await?;
    let names = secrets.keys().map(String::as_str).collect();
    let mut variables = parse(&computer.environment_text, &names)?;
    variables.extend(exposed(&secrets));
    let sent_environment = !variables.is_empty();
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
