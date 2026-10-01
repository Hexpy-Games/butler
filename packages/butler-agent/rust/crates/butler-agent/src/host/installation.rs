//! Immutable files selected once by the process entrypoint.

use butler_platform::{launcher, secure_fs::Canonical as _};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub(crate) struct ResolvedInstallation {
    executable_path: PathBuf,
    installation_root: PathBuf,
    resource_root: PathBuf,
}

#[derive(Clone, Debug)]
pub(crate) struct PayloadProvenance {
    pub(crate) schema: String,
    pub(crate) agent_version: Option<String>,
    pub(crate) app_version: Option<String>,
    pub(crate) platform: Option<String>,
    pub(crate) architecture: Option<String>,
    pub(crate) binary: Option<String>,
    pub(crate) resources: Option<String>,
    pub(crate) launcher: Option<String>,
    pub(crate) binary_sha256: Option<String>,
    pub(crate) resources_sha256: Option<String>,
}

impl ResolvedInstallation {
    pub(crate) fn standalone() -> Result<Self, crate::host::HostError> {
        let executable = butler_platform::process_names::current_exe()
            .map_err(|error| format!("installation_executable_unavailable: {error}"))?;
        let executable = executable
            .canonical()
            .map_err(|error| format!("installation_executable_unavailable: {error}"))?;
        let root = executable
            .parent()
            .ok_or_else(|| "installation_root_unavailable".to_owned())?
            .to_path_buf();
        let resources = root.join("resources");
        Self::new(&executable, &root, &resources)
    }

    pub(crate) fn desktop(
        executable_path: impl Into<PathBuf>,
        installation_root: impl Into<PathBuf>,
        resource_root: impl Into<PathBuf>,
    ) -> Result<Self, crate::host::HostError> {
        Self::new(
            &executable_path.into(),
            &installation_root.into(),
            &resource_root.into(),
        )
    }

    fn new(
        executable: &Path,
        root: &Path,
        resources: &Path,
    ) -> Result<Self, crate::host::HostError> {
        let executable_path = canonical_file(executable, "installation_executable_unavailable")?;
        let installation_root = canonical_dir(root, "installation_root_unavailable")?;
        let resource_root = canonical_dir(resources, "installation_resources_unavailable")?;
        if !executable_path.starts_with(&installation_root)
            || !resource_root.starts_with(&installation_root)
        {
            return Err("installation_layout_invalid".to_owned().into());
        }
        Ok(Self {
            executable_path,
            installation_root,
            resource_root,
        })
    }

    pub(crate) fn executable(&self) -> &Path {
        &self.executable_path
    }

    pub(crate) fn root(&self) -> &Path {
        &self.installation_root
    }

    pub(crate) fn resources(&self) -> &Path {
        &self.resource_root
    }

    /// The directory that holds the payload manifest: the parent of the
    /// resource root, which is the installation root for a standalone
    /// installation and `bundled-agent/` inside an App bundle or package
    /// (whose installation root is the App itself). An installation whose
    /// resources sit elsewhere keeps its manifest in the installation root.
    pub(crate) fn payload_root(&self) -> PathBuf {
        self.resource_root
            .parent()
            .filter(|parent| parent.starts_with(&self.installation_root))
            .map_or_else(|| self.installation_root.clone(), Path::to_path_buf)
    }

    pub(crate) fn app_version(&self) -> Option<String> {
        if let Ok(value) = std::env::var("BUTLER_APP_VERSION")
            && !value.trim().is_empty()
        {
            return Some(value.trim().to_owned());
        }
        let manifest = self.payload_root().join("native-agent-manifest.json");
        if !std::fs::symlink_metadata(&manifest)
            .ok()?
            .file_type()
            .is_file()
        {
            return None;
        }
        let manifest = manifest.canonical().ok()?;
        if !manifest.starts_with(&self.installation_root) {
            return None;
        }
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(manifest).ok()?).ok()?;
        if !matches!(
            value["schema"].as_str(),
            Some("butler.native-agent-payload.v1" | "butler.native-agent-install.v1")
        ) {
            return None;
        }
        string_field(&value, "appVersion")
    }

    pub(crate) fn payload_provenance(
        &self,
    ) -> Result<Option<PayloadProvenance>, crate::host::HostError> {
        let payload_root = self.payload_root();
        let manifest_path = payload_root.join("native-agent-manifest.json");
        let metadata = match std::fs::symlink_metadata(&manifest_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("installation_manifest_unavailable".into()),
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("installation_manifest_invalid".into());
        }
        let manifest_path = manifest_path.canonical().map_err(|source| {
            crate::host::HostError::new("installation_manifest_unavailable").with_source(source)
        })?;
        if !manifest_path.starts_with(&payload_root) {
            return Err("installation_manifest_invalid".into());
        }
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).map_err(|source| {
                crate::host::HostError::new("installation_manifest_unavailable").with_source(source)
            })?)
            .map_err(|source| {
                crate::host::HostError::new("installation_manifest_invalid").with_source(source)
            })?;
        let schema = value["schema"]
            .as_str()
            .ok_or("installation_manifest_invalid")?;
        let binary = value["binary"]
            .as_str()
            .ok_or("installation_manifest_invalid")?;
        let resources = value["resources"]
            .as_str()
            .ok_or("installation_manifest_invalid")?;
        let expected_binary = match schema {
            "butler.native-agent-install.v1" => launcher::AGENT_BINARY.to_owned(),
            "butler.native-agent-payload.v1" => format!("bin/{}", launcher::AGENT_BINARY),
            _ => return Err("installation_manifest_invalid".into()),
        };
        if binary != expected_binary || resources != "resources" {
            return Err("installation_manifest_layout_invalid".into());
        }
        let binary_path = safe_manifest_path(&payload_root, binary)?;
        let resources_path = safe_manifest_path(&payload_root, resources)?;
        if binary_path != self.executable_path || resources_path != self.resource_root {
            return Err("installation_manifest_layout_invalid".into());
        }
        let version = string_field(&value, "version");
        if schema == "butler.native-agent-install.v1" {
            check_install_manifest(&value, &payload_root)?;
        }
        let binary_sha256 = string_field(&value, "binarySha256");
        let resources_sha256 = string_field(&value, "resourcesSha256");
        for digest in [binary_sha256.as_deref(), resources_sha256.as_deref()]
            .into_iter()
            .flatten()
        {
            if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err("installation_manifest_invalid".into());
            }
        }
        Ok(Some(PayloadProvenance {
            schema: schema.into(),
            agent_version: version,
            app_version: string_field(&value, "appVersion"),
            platform: string_field(&value, "platform"),
            architecture: string_field(&value, "architecture"),
            binary: Some(binary.into()),
            resources: Some(resources.into()),
            launcher: string_field(&value, "launcher"),
            binary_sha256,
            resources_sha256,
        }))
    }

    pub(crate) fn agent_version(&self) -> Option<String> {
        self.payload_provenance().ok().flatten()?.agent_version
    }

    pub(crate) fn validate_data_root(
        &self,
        data_root: &Path,
    ) -> Result<PathBuf, crate::host::HostError> {
        let resolved = realpath_or_nearest(data_root)
            .map_err(|error| format!("butler_data_unavailable: {error}"))?;
        if resolved.starts_with(&self.installation_root)
            || self.installation_root.starts_with(&resolved)
        {
            return Err("butler_data_overlaps_installation".to_owned().into());
        }
        #[cfg(test)]
        refuse_owner_data_root(&resolved);
        Ok(resolved)
    }

    pub(crate) fn validate_workspace_root(
        &self,
        workspace: &Path,
    ) -> Result<(), crate::host::HostError> {
        let resolved = realpath_or_nearest(workspace)
            .map_err(|error| format!("workspace_unavailable: {error}"))?;
        if resolved.starts_with(&self.installation_root)
            || self.installation_root.starts_with(&resolved)
        {
            return Err("workspace_overlaps_installation".to_owned().into());
        }
        Ok(())
    }
}

/// Unit tests never resolve the owner's own data folder: `cargo test` run from a
/// shell that exports `BUTLER_DATA=~/.butler` would otherwise read and write real
/// data. A test uses a temp data root; a `~/.butler` inside the temp dir is fine.
#[cfg(test)]
fn refuse_owner_data_root(resolved: &Path) {
    let real = |path: PathBuf| realpath_or_nearest(&path).ok();
    let owner = butler_platform::user_dirs::home_dir().and_then(|home| real(home.join(".butler")));
    let temp = real(std::env::temp_dir());
    assert_test_data_root_is_isolated(resolved, owner.as_deref(), temp.as_deref());
}

#[cfg(test)]
fn assert_test_data_root_is_isolated(resolved: &Path, owner: Option<&Path>, temp: Option<&Path>) {
    assert!(
        !owner.is_some_and(|owner| resolved.starts_with(owner))
            || temp.is_some_and(|temp| resolved.starts_with(temp)),
        "test resolved the owner's data folder {}; point it at a temp dir",
        resolved.display()
    );
}

/// Platforms a standalone installation (`butler.native-agent-install.v1`) may
/// target, using the release archive's OS and architecture names.
const INSTALL_PLATFORMS: [(&str, &str); 4] = [
    ("darwin", "arm64"),
    ("linux", "x64"),
    ("linux", "arm64"),
    ("windows", "x64"),
];

/// The standalone installation's own fields: platform, version, launcher and digests.
fn check_install_manifest(
    value: &serde_json::Value,
    root: &Path,
) -> Result<(), crate::host::HostError> {
    check_install_platform(
        (value["platform"].as_str(), value["architecture"].as_str()),
        host_install_platform(),
    )?;
    if string_field(value, "version").is_none()
        || value["launcher"].as_str() != Some(launcher::AGENT_LAUNCHER)
        || string_field(value, "binarySha256").is_none()
        || string_field(value, "resourcesSha256").is_none()
        || !launcher::installed_launcher_is_expected(root)
    {
        return Err("installation_manifest_invalid".into());
    }
    Ok(())
}

/// This host in install-manifest names.
fn host_install_platform() -> (&'static str, &'static str) {
    let platform = launcher::RELEASE_OS;
    let architecture = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    (platform, architecture)
}

/// An installation manifest must name a supported platform, and the host's own.
fn check_install_platform(
    manifest: (Option<&str>, Option<&str>),
    host: (&str, &str),
) -> Result<(), crate::host::HostError> {
    let (Some(platform), Some(architecture)) = manifest else {
        return Err("installation_manifest_invalid".into());
    };
    if (platform, architecture) != host || !INSTALL_PLATFORMS.contains(&(platform, architecture)) {
        return Err("installation_manifest_invalid".into());
    }
    Ok(())
}

fn string_field(value: &serde_json::Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn safe_manifest_path(root: &Path, relative: &str) -> Result<PathBuf, crate::host::HostError> {
    let relative = Path::new(relative);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("installation_manifest_layout_invalid".into());
    }
    let path = root.join(relative).canonical().map_err(|source| {
        crate::host::HostError::new("installation_manifest_layout_invalid").with_source(source)
    })?;
    if !path.starts_with(root) {
        return Err("installation_manifest_layout_invalid".into());
    }
    Ok(path)
}

fn canonical_file(path: &Path, code: &str) -> Result<PathBuf, crate::host::HostError> {
    let resolved = path
        .canonical()
        .map_err(|error| format!("{code}: {error}"))?;
    if !resolved.is_file() {
        return Err(code.to_owned().into());
    }
    Ok(resolved)
}

fn canonical_dir(path: &Path, code: &str) -> Result<PathBuf, crate::host::HostError> {
    let resolved = path
        .canonical()
        .map_err(|error| format!("{code}: {error}"))?;
    if !resolved.is_dir() {
        return Err(code.to_owned().into());
    }
    Ok(resolved)
}

pub(crate) fn realpath_or_nearest(path: &Path) -> std::io::Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut current = absolute;
    let mut suffix = Vec::new();
    loop {
        match current.canonical() {
            Ok(real) => {
                return Ok(suffix
                    .into_iter()
                    .rev()
                    .fold(real, |base, item| base.join(item)));
            }
            Err(error) if current.parent().is_none() => return Err(error),
            Err(_) => {
                let name = current
                    .file_name()
                    .ok_or_else(|| std::io::Error::other("path has no existing ancestor"))?;
                suffix.push(name.to_os_string());
                current = current
                    .parent()
                    .ok_or_else(|| std::io::Error::other("path has no existing ancestor"))?
                    .to_path_buf();
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::ResolvedInstallation;
    use butler_platform::secure_fs::Canonical as _;

    pub(crate) fn data_and_workspace_cannot_overlap_the_installation() {
        let executable = butler_platform::process_names::current_exe()
            .unwrap()
            .canonical()
            .unwrap();
        let root = executable.parent().unwrap().to_path_buf();
        let installation = ResolvedInstallation::desktop(&executable, &root, &root).unwrap();
        assert_eq!(
            installation.validate_data_root(&root).unwrap_err(),
            "butler_data_overlaps_installation"
        );
        assert_eq!(
            installation
                .validate_data_root(root.parent().unwrap())
                .unwrap_err(),
            "butler_data_overlaps_installation"
        );
        assert_eq!(
            installation.validate_workspace_root(&root).unwrap_err(),
            "workspace_overlaps_installation"
        );
        let outside =
            std::env::temp_dir().join(format!("butler-installation-test-{}", std::process::id()));
        assert!(
            installation
                .validate_data_root(&outside)
                .unwrap()
                .ends_with(outside.file_name().unwrap())
        );
        installation.validate_workspace_root(&outside).unwrap();

        let owner_root = std::env::current_dir()
            .unwrap()
            .join("test-owner")
            .join(".butler");
        let temp_root = owner_root.with_file_name("other-temp");
        let resolved = owner_root.join("project-ledger");
        assert!(
            std::panic::catch_unwind(|| {
                super::assert_test_data_root_is_isolated(
                    &resolved,
                    Some(&owner_root),
                    Some(&temp_root),
                );
            })
            .is_err()
        );
    }
}
