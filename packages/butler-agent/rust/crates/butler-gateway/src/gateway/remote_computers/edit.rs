use super::{
    AddInput, AppSetupPort, Computer, HostInput, HttpError, ModelInput, ModelSource, environment,
    list, locked, model_sync, probe, remote_error, ssh, ssh_key, ssh_password::Install, store,
};
use std::{path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

pub(in crate::gateway) async fn edit(
    setup: &Arc<dyn AppSetupPort>,
    root: &Path,
    id: &str,
    version: &str,
    input: AddInput,
    password: Option<Zeroizing<String>>,
    cancel: CancellationToken,
) -> Result<(Computer, bool), HttpError> {
    let (name, folder) = input.validate(password.is_some())?;
    let mut target = HostInput {
        address: input.address,
        port: input.port,
        key_file: input.key_file,
        identity: None,
    };
    target.validate()?;
    let (lock, this) = locked(root, id).await?;
    let mut text = input.environment_text;
    let values = if input.environment.is_some() || text.is_some() {
        let next_text = text.as_deref().unwrap_or(&this.environment_text);
        Some(environment::prepare(setup, &this, next_text, input.environment).await?)
    } else {
        None
    };
    text.iter_mut().for_each(super::normalize_environment_text);
    let model_source = input.model_source;
    if let ModelSource::Key(id) = &model_source {
        setup.computer_model(Some(id.clone())).await?;
    }
    let details = target_details(
        root,
        &this,
        (&name, &folder),
        &target,
        password,
        cancel.clone(),
    )
    .await?;
    let change = changes(name.clone(), &target, folder, &details, text);
    let saved = save(setup, root, &this, name, values, change).await;
    let (computer, secrets_changed) = match saved {
        Ok(result) => result,
        Err(error) => {
            details.install.rollback(&target, &details.check).await;
            return Err(error);
        }
    };
    let environment_changed = secrets_changed
        || computer.environment != this.environment
        || computer.environment_text != this.environment_text;
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
    Ok((computer, details.target_changed))
}

async fn save(
    setup: &Arc<dyn AppSetupPort>,
    root: &Path,
    this: &Computer,
    name: String,
    values: Option<environment::Edit>,
    change: impl FnOnce(&mut Computer, Option<Vec<String>>) + Send + 'static,
) -> Result<(Computer, bool), HttpError> {
    let (names, previous) = if let Some(values) = values {
        let previous = if let Some((stored, next)) = values.changed_secrets {
            setup
                .save_computer_environment(this.id.clone(), next)
                .await?;
            Some(stored)
        } else {
            None
        };
        (values.names, previous)
    } else {
        (None, None)
    };
    let edited = store::edit(
        root.join("config/computers.json"),
        this.id.clone(),
        name,
        move |computer| change(computer, names),
    )
    .await;
    let secrets_changed = previous.is_some();
    if edited.is_err()
        && let Some(previous) = previous
    {
        setup
            .save_computer_environment(this.id.clone(), previous)
            .await?;
    }
    Ok((edited?, secrets_changed))
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

struct TargetDetails {
    check: ssh::HostCheck,
    install: Install,
    platform: Option<probe::Platform>,
    managed_key: bool,
    target_changed: bool,
}

async fn target_details(
    root: &Path,
    this: &Computer,
    (name, folder): (&str, &str),
    input: &HostInput,
    password: Option<Zeroizing<String>>,
    cancel: CancellationToken,
) -> Result<TargetDetails, HttpError> {
    let mut others = list(root).await?;
    others.retain(|computer| computer.id != this.id);
    store::unique_name(&others, name)?;
    let (target_changed, folder_changed) = changed(this, input, folder);
    let target_changed = target_changed || password.is_some();
    let managed_key = password.is_some() || (this.managed_key && input.key_file.is_none());
    let mut target = input.clone();
    let _key = if managed_key && password.is_none() && (target_changed || folder_changed) {
        Some(ssh_key::managed_target(&mut target).await?)
    } else {
        None
    };
    let check = if target_changed {
        let check = ssh::host_key(&target, &others, cancel.clone()).await?;
        if !same_machine(&check.lines, &this.host_keys) {
            return Err(HttpError::public(
                409,
                "computer_host_different",
                "This address is a different computer.",
            ));
        }
        check
    } else {
        ssh::HostCheck {
            lines: this.host_keys.clone(),
            methods: Vec::new(),
            proxied: false,
        }
    };
    let install = Install::start(input, &check, password, cancel.clone()).await?;
    let platform = if target_changed || folder_changed {
        match install
            .probe(&target, folder, &others, &check.lines, managed_key, cancel)
            .await
        {
            Ok(platform) => Some(platform),
            Err(error) => {
                install.rollback(input, &check).await;
                return Err(error);
            }
        }
    } else {
        None
    };
    Ok(TargetDetails {
        check,
        install,
        platform,
        managed_key,
        target_changed,
    })
}

fn changed(this: &Computer, target: &HostInput, folder: &str) -> (bool, bool) {
    let port = target.port.and_then(|port| u16::try_from(port).ok());
    let target_changed =
        this.address != target.address || this.port != port || this.key_file != target.key_file;
    (target_changed, this.folder != folder)
}

fn changes(
    name: String,
    target: &HostInput,
    folder: String,
    details: &TargetDetails,
    text: Option<String>,
) -> impl FnOnce(&mut Computer, Option<Vec<String>>) + use<> {
    let HostInput {
        address,
        port,
        key_file,
        ..
    } = target.clone();
    let keys = details.check.lines.clone();
    let platform = details.platform.clone();
    let managed_key = details.managed_key;
    let key_added = details.install.added();
    move |computer, names| {
        computer.name = name;
        computer.address = address;
        computer.port = port.and_then(|port| u16::try_from(port).ok());
        computer.key_file = key_file;
        computer.managed_key = managed_key;
        computer.key_added = managed_key && (computer.key_added || key_added);
        computer.folder = folder;
        computer.host_keys = keys;
        if let Some(names) = names {
            computer.environment = names;
        }
        if let Some(text) = text {
            computer.environment_text = text;
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
