//! Minimal one-shot composition of the existing Profile service owner.

use std::{env, path::Path, path::PathBuf, sync::Arc};

use crate::{
    configuration::ConfigurationWrites,
    conversation::conversation_store_path,
    coordination::CognitionWriteCoordinator,
    locale::LocaleCollation,
    profile::{PersonaPresets, ProfileService},
};

use super::super::{
    NativeProcessEnvironment, NativeProcessModels, ProfileConversationSources,
    ResolvedInstallation, SystemIdentity, settings_cli,
};

pub(super) fn open(
    data_root: &Path,
    installation: &ResolvedInstallation,
    mutating: bool,
) -> Result<Arc<ProfileService>, String> {
    let host = Arc::new(SystemIdentity);
    let coordinator = Arc::new(
        CognitionWriteCoordinator::new(host.clone())
            .map_err(|_| "profile coordinator is unavailable".to_owned())?,
    );
    let home = env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root.to_path_buf());
    let os = nix::sys::utsname::uname().map_err(|_| "native environment is unavailable")?;
    let environment =
        NativeProcessEnvironment::capture(data_root, &home, &os.release().to_string_lossy());
    let cognition_root = environment.cognition_paths.cognition_root(data_root);
    validate_cognition_paths(data_root, installation, &cognition_root, mutating)?;
    let locale = process_locale();
    let collation = Arc::new(
        LocaleCollation::new(&locale).map_err(|_| "native locale is unavailable".to_owned())?,
    );
    let writes = Arc::new(ConfigurationWrites::new());
    let models = NativeProcessModels::new(
        data_root.to_path_buf(),
        environment.model,
        writes.clone(),
        collation,
    )
    .map_err(|_| "native profile provider is unavailable".to_owned())?;
    Ok(Arc::new(ProfileService::new(
        data_root.to_path_buf(),
        cognition_root,
        Arc::new(PersonaPresets::new(installation.resources().to_path_buf())),
        writes,
        coordinator,
        host,
        Arc::new(ProfileConversationSources::new(conversation_store_path(
            data_root,
        ))),
        models.provider.clone(),
    )))
}

fn validate_cognition_paths(
    data_root: &Path,
    installation: &ResolvedInstallation,
    cognition_root: &Path,
    mutating: bool,
) -> Result<(), String> {
    if !mutating {
        return Ok(());
    }
    let lock = cognition_root.join("consolidation/locks/consolidation.lock");
    let mut coordinator = lock.as_os_str().to_os_string();
    coordinator.push(".coord.sqlite");
    let coordinator = PathBuf::from(coordinator);
    let mut journal = coordinator.as_os_str().to_os_string();
    journal.push("-journal");
    let journal = PathBuf::from(journal);
    settings_cli::validate_absolute_data_mutation_paths(
        data_root,
        installation,
        &[&lock, &coordinator, &journal],
    )
    .map_err(|_| "profile cognition paths must remain inside DATA without symlinks".to_owned())
}

fn process_locale() -> String {
    let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .find_map(|key| env::var(key).ok())
        .unwrap_or_else(|| "C".into());
    let base = locale.split(['.', '@']).next().unwrap_or("C");
    if matches!(base, "" | "C" | "POSIX") {
        "en-US".into()
    } else {
        base.replace('_', "-")
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{ResolvedInstallation, validate_cognition_paths};

    #[test]
    fn cognition_override_must_remain_inside_data() {
        let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
        let install_root = executable.parent().unwrap();
        let installation =
            ResolvedInstallation::desktop(&executable, install_root, install_root).unwrap();
        let root = std::env::temp_dir().join(format!(
            "butler-profile-cognition-override-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let requested_data = root.join("data");
        fs::create_dir_all(&requested_data).unwrap();
        let data = requested_data.canonicalize().unwrap();

        assert!(
            validate_cognition_paths(&data, &installation, &data.join("custom-cognition"), true,)
                .is_ok()
        );
        assert!(
            validate_cognition_paths(&data, &installation, &root.join("outside-cognition"), true,)
                .is_err()
        );
        assert!(
            validate_cognition_paths(&data, &installation, &root.join("outside-cognition"), false,)
                .is_ok()
        );
        assert!(!root.join("outside-cognition").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
