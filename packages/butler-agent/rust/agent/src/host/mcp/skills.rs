//! One-shot Skills owner adapter for the retained `skill_list` tool.

use std::path::Path;

use super::super::ResolvedInstallation;
use crate::skills::NativeSkills;

pub(super) async fn list_text(installation: &ResolvedInstallation, data_root: &Path) -> String {
    let skills = NativeSkills::new(
        installation.resources().to_path_buf(),
        data_root.to_path_buf(),
    );
    let output = match skills.runtime_catalog(None).await {
        Ok(definitions) if definitions.is_empty() => "No skills loaded.".to_owned(),
        Ok(definitions) => definitions
            .iter()
            .map(|skill| {
                let model = skill
                    .model
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .map(|value| format!(" [{value}]"))
                    .unwrap_or_default();
                let internal = if skill.user_invocable {
                    ""
                } else {
                    " (internal)"
                };
                let source = skill
                    .file_path
                    .parent()
                    .and_then(Path::parent)
                    .and_then(Path::file_name)
                    .map(|value| value.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "local".into());
                format!(
                    "• **{}**{}{} — {}\n  applicability: {}\n  source: {}",
                    skill.name, model, internal, skill.description, skill.applicability, source
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
        Err(_) => "No skills loaded.".to_owned(),
    };
    skills.close().await;
    output
}
