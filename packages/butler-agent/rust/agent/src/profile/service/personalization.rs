use std::{fs, path::Path};

use super::ProfileService;
use crate::{
    profile::{PersonaLocale, PersonaPreset},
    public_text::trim_js_whitespace,
};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct PersonalizationDocuments {
    pub persona: String,
    pub eol: String,
}

impl ProfileService {
    pub(crate) async fn read_personalization_documents(
        &self,
    ) -> super::super::contracts::ProfileResult<PersonalizationDocuments> {
        let root = self.data_root.clone();
        self.run(move || {
            Ok(PersonalizationDocuments {
                persona: read_private_text(&root.join("personas/active.md")),
                eol: read_private_text(&root.join("eol.md")),
            })
        })
        .await
    }

    pub(crate) async fn update_personalization_documents(
        &self,
        persona: Option<String>,
        eol: Option<String>,
    ) -> super::super::contracts::ProfileResult<()> {
        let guard = self.configuration_writes.acquire_owned().await;
        let root = self.data_root.clone();
        let host = self.host.clone();
        self.run(move || {
            let _guard = guard;
            if let Some(persona) = persona {
                write_private_text(
                    &root,
                    &root.join("personas/active.md"),
                    "persona-active",
                    &bounded_private_text(&persona),
                    &host.now_iso(),
                )?;
            }
            if let Some(eol) = eol {
                write_private_text(
                    &root,
                    &root.join("eol.md"),
                    "eol",
                    &bounded_private_text(&eol),
                    &host.now_iso(),
                )?;
            }
            Ok(())
        })
        .await
    }

    pub(crate) async fn read_persona_presets(
        &self,
        locale: &str,
    ) -> super::super::contracts::ProfileResult<Vec<PersonaPreset>> {
        let presets = self.presets.clone();
        let locale = if locale == "ko" {
            PersonaLocale::Ko
        } else {
            PersonaLocale::En
        };
        self.run(move || Ok(presets.list(locale))).await
    }
}

fn read_private_text(path: &Path) -> String {
    fs::read_to_string(path)
        .ok()
        .map(|text| truncate_utf16(&text, 32_000))
        .unwrap_or_default()
}

fn bounded_private_text(value: &str) -> String {
    truncate_utf16(trim_js_whitespace(&value.replace("\r\n", "\n")), 32_000)
}

fn truncate_utf16(value: &str, limit: usize) -> String {
    let mut units = 0;
    value
        .chars()
        .take_while(|character| {
            let next = units + character.len_utf16();
            if next > limit {
                false
            } else {
                units = next;
                true
            }
        })
        .collect()
}

fn write_private_text(
    data_root: &Path,
    path: &Path,
    prefix: &str,
    text: &str,
    now: &str,
) -> super::super::contracts::ProfileResult<()> {
    let parent = path.parent().ok_or_else(write_error)?;
    fs::create_dir_all(parent).map_err(|_| write_error())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
    }
    backup_private_text(data_root, path, prefix, text, now)?;
    fs::write(path, text.as_bytes()).map_err(|_| write_error())
}

fn backup_private_text(
    data_root: &Path,
    source: &Path,
    prefix: &str,
    next_text: &str,
    now: &str,
) -> super::super::contracts::ProfileResult<()> {
    let Ok(metadata) = fs::metadata(source) else {
        return Ok(());
    };
    if !metadata.is_file() {
        return Ok(());
    }
    let current = read_private_text(source);
    if current.is_empty() || current == next_text {
        return Ok(());
    }
    let directory = data_root.join("personalization/backups");
    fs::create_dir_all(&directory).map_err(|_| write_error())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&directory, fs::Permissions::from_mode(0o700));
    }
    let stamp = now.replace([':', '.'], "-");
    let target = directory.join(format!("{prefix}-{stamp}.md"));
    fs::copy(source, target).map_err(|_| write_error())?;
    prune_backups(&directory, prefix)?;
    Ok(())
}

fn prune_backups(directory: &Path, prefix: &str) -> super::super::contracts::ProfileResult<()> {
    let entries = fs::read_dir(directory).map_err(|_| write_error())?;
    let mut backups = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            (name.starts_with(&format!("{prefix}-")) && name.ends_with(".md"))
                .then(|| {
                    entry
                        .metadata()
                        .ok()
                        .map(|metadata| (metadata.modified().ok(), entry.path()))
                })
                .flatten()
        })
        .collect::<Vec<_>>();
    backups.sort_by(|left, right| right.0.cmp(&left.0));
    for (_, path) in backups.into_iter().skip(20) {
        fs::remove_file(path).map_err(|_| write_error())?;
    }
    Ok(())
}

fn write_error() -> super::super::contracts::ProfileError {
    super::super::contracts::ProfileError::new(
        "personalization_write_failed",
        "Personalization could not be written.",
    )
}

#[cfg(test)]
mod tests {
    use super::{bounded_private_text, read_private_text};
    use std::{fs, path::PathBuf};

    #[test]
    fn private_text_matches_utf16_slice_and_trim_boundaries() {
        assert_eq!(bounded_private_text(" \r\na\r\nb \n"), "a\nb");
        let value = format!("{}x", "😀".repeat(16_000));
        assert_eq!(bounded_private_text(&value), "😀".repeat(16_000));
    }

    #[test]
    fn private_text_reads_existing_files_and_defaults_missing_files() {
        let root = std::env::temp_dir().join(format!("profile-text-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("active.md");
        fs::write(&file, "persona").unwrap();
        assert_eq!(read_private_text(&file), "persona");
        assert_eq!(
            read_private_text(&PathBuf::from("/missing/profile-text.md")),
            ""
        );
        fs::remove_dir_all(root).unwrap();
    }
}
