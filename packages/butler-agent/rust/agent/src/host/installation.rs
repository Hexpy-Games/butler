//! Immutable files selected once by the process entrypoint.

use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct ResolvedInstallation {
    executable_path: PathBuf,
    installation_root: PathBuf,
    resource_root: PathBuf,
}

#[derive(Clone, Debug)]
pub(crate) struct NativePayloadProvenance {
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
    pub fn standalone() -> Result<Self, String> {
        let executable = std::env::current_exe()
            .map_err(|error| format!("installation_executable_unavailable: {error}"))?;
        let executable = executable
            .canonicalize()
            .map_err(|error| format!("installation_executable_unavailable: {error}"))?;
        let root = executable
            .parent()
            .ok_or_else(|| "installation_root_unavailable".to_owned())?
            .to_path_buf();
        let resources = root.join("resources");
        Self::new(executable, root, resources)
    }

    pub fn desktop(
        executable_path: impl Into<PathBuf>,
        installation_root: impl Into<PathBuf>,
        resource_root: impl Into<PathBuf>,
    ) -> Result<Self, String> {
        Self::new(
            executable_path.into(),
            installation_root.into(),
            resource_root.into(),
        )
    }

    fn new(executable: PathBuf, root: PathBuf, resources: PathBuf) -> Result<Self, String> {
        let executable_path = canonical_file(&executable, "installation_executable_unavailable")?;
        let installation_root = canonical_dir(&root, "installation_root_unavailable")?;
        let resource_root = canonical_dir(&resources, "installation_resources_unavailable")?;
        if !executable_path.starts_with(&installation_root)
            || !resource_root.starts_with(&installation_root)
        {
            return Err("installation_layout_invalid".to_owned());
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

    pub(crate) fn app_version(&self) -> Option<String> {
        if let Ok(value) = std::env::var("BUTLER_APP_VERSION")
            && !value.trim().is_empty()
        {
            return Some(value.trim().to_owned());
        }
        let manifest = self
            .resource_root
            .parent()?
            .join("native-agent-manifest.json");
        if !std::fs::symlink_metadata(&manifest)
            .ok()?
            .file_type()
            .is_file()
        {
            return None;
        }
        let manifest = manifest.canonicalize().ok()?;
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

    pub(crate) fn native_payload_provenance(
        &self,
    ) -> Result<Option<NativePayloadProvenance>, String> {
        let manifest_path = self.installation_root.join("native-agent-manifest.json");
        let metadata = match std::fs::symlink_metadata(&manifest_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("installation_manifest_unavailable".into()),
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("installation_manifest_invalid".into());
        }
        let manifest_path = manifest_path
            .canonicalize()
            .map_err(|_| "installation_manifest_unavailable")?;
        if !manifest_path.starts_with(&self.installation_root) {
            return Err("installation_manifest_invalid".into());
        }
        let value: serde_json::Value = serde_json::from_slice(
            &std::fs::read(&manifest_path).map_err(|_| "installation_manifest_unavailable")?,
        )
        .map_err(|_| "installation_manifest_invalid")?;
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
            "butler.native-agent-install.v1" => "butler-agent",
            "butler.native-agent-payload.v1" => "bin/butler-agent",
            _ => return Err("installation_manifest_invalid".into()),
        };
        if binary != expected_binary || resources != "resources" {
            return Err("installation_manifest_layout_invalid".into());
        }
        let binary_path = safe_manifest_path(&self.installation_root, binary)?;
        let resources_path = safe_manifest_path(&self.installation_root, resources)?;
        if binary_path != self.executable_path || resources_path != self.resource_root {
            return Err("installation_manifest_layout_invalid".into());
        }
        let version = string_field(&value, "version");
        if schema == "butler.native-agent-install.v1"
            && (version.is_none()
                || value["platform"].as_str() != Some("darwin")
                || value["architecture"].as_str() != Some("arm64")
                || value["launcher"].as_str() != Some("butler")
                || string_field(&value, "binarySha256").is_none()
                || string_field(&value, "resourcesSha256").is_none()
                || !launcher_is_expected(&self.installation_root))
        {
            return Err("installation_manifest_invalid".into());
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
        Ok(Some(NativePayloadProvenance {
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
        self.native_payload_provenance()
            .ok()
            .flatten()?
            .agent_version
    }

    pub(crate) fn validate_data_root(&self, data_root: &Path) -> Result<PathBuf, String> {
        let resolved = realpath_or_nearest(data_root)
            .map_err(|error| format!("butler_data_unavailable: {error}"))?;
        if resolved.starts_with(&self.installation_root)
            || self.installation_root.starts_with(&resolved)
        {
            return Err("butler_data_overlaps_installation".to_owned());
        }
        Ok(resolved)
    }

    pub(crate) fn validate_workspace_root(&self, workspace: &Path) -> Result<(), String> {
        let resolved = realpath_or_nearest(workspace)
            .map_err(|error| format!("workspace_unavailable: {error}"))?;
        if resolved.starts_with(&self.installation_root)
            || self.installation_root.starts_with(&resolved)
        {
            return Err("workspace_overlaps_installation".to_owned());
        }
        Ok(())
    }
}

fn string_field(value: &serde_json::Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn safe_manifest_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("installation_manifest_layout_invalid".into());
    }
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|_| "installation_manifest_layout_invalid")?;
    if !path.starts_with(root) {
        return Err("installation_manifest_layout_invalid".into());
    }
    Ok(path)
}

fn launcher_is_expected(root: &Path) -> bool {
    let launcher = root.join("butler");
    std::fs::symlink_metadata(&launcher).is_ok_and(|metadata| metadata.file_type().is_symlink())
        && std::fs::read_link(launcher).is_ok_and(|target| target == Path::new("butler-agent"))
}

fn canonical_file(path: &Path, code: &str) -> Result<PathBuf, String> {
    let resolved = path
        .canonicalize()
        .map_err(|error| format!("{code}: {error}"))?;
    if !resolved.is_file() {
        return Err(code.to_owned());
    }
    Ok(resolved)
}

fn canonical_dir(path: &Path, code: &str) -> Result<PathBuf, String> {
    let resolved = path
        .canonicalize()
        .map_err(|error| format!("{code}: {error}"))?;
    if !resolved.is_dir() {
        return Err(code.to_owned());
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
        match current.canonicalize() {
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
mod tests {
    use super::ResolvedInstallation;

    #[test]
    fn data_and_workspace_cannot_overlap_the_installation() {
        let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
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
    }
}
