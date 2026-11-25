use super::{
    AddInput, AppSetupPort, Computer, HostInput, HttpError, ModelInput, ModelSource, environment,
    list, locked, model_sync, remote_error, ssh, store,
};
use std::{path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(in crate::gateway) async fn edit(
    setup: &Arc<dyn AppSetupPort>,
    root: &Path,
    id: &str,
    version: &str,
    input: AddInput,
    cancel: CancellationToken,
) -> Result<(Computer, bool), HttpError> {
    let (name, folder) = input.validate()?;
    let mut target = HostInput {
        address: input.address,
        port: input.port,
        key_file: input.key_file,
    };
    target.validate()?;
    let (lock, this) = locked(root, id).await?;
    let values = if let Some(input) = input.environment {
        let previous = setup.computer_environment(id.to_owned()).await?;
        let next = environment::merge(&previous, input)?;
        Some((previous, next))
    } else {
        None
    };
    let (keys, platform, target_changed) =
        target_details(root, &this, &name, &target, &folder, cancel.clone()).await?;
    let model_source = input.model_source;
    if let ModelSource::Key(id) = &model_source {
        setup.computer_model(Some(id.clone())).await?;
    }
    let mut previous = None;
    let mut names = None;
    if let Some((stored, next)) = values {
        names = Some(next.keys().cloned().collect::<Vec<_>>());
        if !stored
            .iter()
            .map(|(key, value)| (key, value.expose()))
            .eq(next.iter().map(|(key, value)| (key, value.expose())))
        {
            setup.save_computer_environment(id.to_owned(), next).await?;
            previous = Some(stored);
        }
    }
    let environment_changed = previous.is_some()
        || names
            .as_ref()
            .is_some_and(|names| *names != this.environment);
    let edited = store::edit(
        root.join("config/computers.json"),
        id.to_owned(),
        name.clone(),
        changes(name, target, folder, keys, platform, names),
    )
    .await;
    if edited.is_err()
        && let Some(previous) = previous
    {
        setup
            .save_computer_environment(id.to_owned(), previous)
            .await?;
    }
    let computer = edited?;
    drop(lock);

    let model = (model_source != this.model_source).then_some(ModelInput {
        model_source,
        open_sign_in: input.open_sign_in,
    });
    let computer = finish(
        setup,
        (root, version),
        computer,
        model,
        environment_changed,
        cancel,
    )
    .await?;
    Ok((computer, target_changed))
}

async fn finish(
    setup: &Arc<dyn AppSetupPort>,
    (root, version): (&Path, &str),
    computer: Computer,
    model: Option<ModelInput>,
    environment_changed: bool,
    cancel: CancellationToken,
) -> Result<Computer, HttpError> {
    let id = computer.id.clone();
    let model_result = if let Some(model) = model {
        model_sync::update(
            setup,
            root,
            &format!("/computers/{id}"),
            version,
            model,
            cancel.clone(),
        )
        .await
        .map_err(|error| match error {
            HttpError::Public {
                status: 404,
                ref code,
                ..
            } if code == "computer_not_found" => error,
            _ => remote_error(
                "remote_model_sync_failed",
                "Could not send the model to this computer.",
            ),
        })
    } else {
        Ok(computer)
    };
    if environment_changed {
        let (_lock, latest) = locked(root, &id).await?;
        environment::push(setup, root, &latest, cancel)
            .await
            .map_err(|_| {
                remote_error(
                    "remote_env_sync_failed",
                    "Could not send the environment variables to this computer.",
                )
            })?;
    }
    model_result
}

async fn target_details(
    root: &Path,
    this: &Computer,
    name: &str,
    target: &HostInput,
    folder: &str,
    cancel: CancellationToken,
) -> Result<(Vec<String>, Option<ssh::Platform>, bool), HttpError> {
    let mut others = list(root).await?;
    others.retain(|computer| computer.id != this.id);
    store::unique_name(&others, name)?;
    let (target_changed, folder_changed) = changed(this, target, folder);
    let keys = if target_changed {
        let keys = ssh::host_key(target, &others, cancel.clone()).await?;
        if !same_machine(&keys, &this.host_keys) {
            return Err(HttpError::public(
                409,
                "computer_host_different",
                "This address is a different computer.",
            ));
        }
        keys
    } else {
        this.host_keys.clone()
    };
    let platform = if target_changed || folder_changed {
        Some(ssh::probe(target, folder, &others, &keys, cancel).await?)
    } else {
        None
    };
    Ok((keys, platform, target_changed))
}

fn changed(this: &Computer, target: &HostInput, folder: &str) -> (bool, bool) {
    let port = target.port.and_then(|port| u16::try_from(port).ok());
    let target_changed =
        this.address != target.address || this.port != port || this.key_file != target.key_file;
    (target_changed, this.folder != folder)
}

fn changes(
    name: String,
    target: HostInput,
    folder: String,
    keys: Vec<String>,
    platform: Option<ssh::Platform>,
    names: Option<Vec<String>>,
) -> impl FnOnce(&mut Computer) {
    move |computer| {
        computer.name = name;
        computer.address = target.address;
        computer.port = target.port.and_then(|port| u16::try_from(port).ok());
        computer.key_file = target.key_file;
        computer.folder = folder;
        computer.host_keys = keys;
        if let Some(names) = names {
            computer.environment = names;
        }
        if let Some(platform) = platform {
            computer.os = platform.os;
            computer.arch = platform.arch;
            computer.glibc = platform.glibc;
            computer.stops_on_logout = platform.stops_on_logout;
        }
    }
}

fn same_machine(new_lines: &[String], stored: &[String]) -> bool {
    let [mut new_keys, stored_keys] = [new_lines, stored].map(|lines| {
        lines.iter().filter_map(|line| {
            let mut fields = line.split_whitespace();
            if fields.next()?.starts_with('@') {
                return None;
            }
            Some((fields.next()?, fields.next()?))
        })
    });
    new_keys.any(|new| stored_keys.clone().any(|old| old == new))
}
