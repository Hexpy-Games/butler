//! Persona and end-of-life documents and persona presets.

use std::{fs, io::Write, path::Path};

use super::ProfileService;
use crate::profile::{PersonaLocale, PersonaPreset, ProfileCode};
use butler_core::public_text::trim_js_whitespace;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PersonalizationDocuments {
    pub persona: String,
    pub eol: String,
}

impl ProfileService {
    /// The persona and end-of-life documents.
    pub async fn read_personalization_documents(
        &self,
    ) -> super::super::contracts::ProfileResult<PersonalizationDocuments> {
        let guard = self.configuration_writes.acquire_owned().await;
        let root = self.data_root.clone();
        let template = self.presets.eol_template();
        self.run(move || {
            let _guard = guard;
            seed_document(&root.join("eol.md"), || fs::read_to_string(template))?;
            Ok(PersonalizationDocuments {
                persona: read_private_text(&root.join("personas/active.md")),
                eol: read_private_text(&root.join("eol.md")),
            })
        })
        .await
    }

    pub(super) async fn ensure_default_eol(&self) -> super::super::contracts::ProfileResult<()> {
        let guard = self.configuration_writes.acquire_owned().await;
        let root = self.data_root.clone();
        let template = self.presets.eol_template();
        self.run(move || {
            let _guard = guard;
            seed_document(&root.join("eol.md"), || fs::read_to_string(template))
        })
        .await
    }

    /// Seeds the bundled soul and default Butler persona only when absent or empty.
    pub async fn seed_default_documents(
        &self,
        language: &str,
    ) -> super::super::contracts::ProfileResult<()> {
        let guard = self.configuration_writes.acquire_owned().await;
        let root = self.data_root.clone();
        let presets = self.presets.clone();
        let locale = if language == "ko" {
            PersonaLocale::Ko
        } else {
            PersonaLocale::En
        };
        self.run(move || {
            let _guard = guard;
            seed_document(&root.join("eol.md"), || {
                fs::read_to_string(presets.eol_template())
            })?;
            seed_document(&root.join("personas/active.md"), || {
                presets
                    .read(locale, "butler")
                    .map(|preset| preset.content)
                    .ok_or_else(|| {
                        std::io::Error::new(
                            std::io::ErrorKind::NotFound,
                            "Default Butler persona missing",
                        )
                    })
            })
        })
        .await
    }

    /// Writes the persona and end-of-life documents.
    pub async fn update_personalization_documents(
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

    /// The persona presets in `locale`.
    pub async fn read_persona_presets(
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

fn seed_document(
    path: &Path,
    template: impl FnOnce() -> std::io::Result<String>,
) -> super::super::contracts::ProfileResult<()> {
    if !document_empty(path)? {
        return Ok(());
    }
    let _change = butler_core::configuration::lock_file(path)
        .map_err(|source| write_error().with_source(source))?;
    if !document_empty(path)? {
        return Ok(());
    }
    let text = template().map_err(|source| write_error().with_source(source))?;
    if trim_js_whitespace(&text).is_empty() {
        return Err(write_error());
    }
    let parent = path.parent().ok_or_else(write_error)?;
    butler_platform::secure_fs::create_private_dir_all(parent)
        .map_err(|source| write_error().with_source(source))?;
    butler_platform::secure_fs::replace_private(
        path,
        |file| file.write_all(text.as_bytes()),
        |error| error,
    )
    .map_err(|source| write_error().with_source(source))
}

fn document_empty(path: &Path) -> super::super::contracts::ProfileResult<bool> {
    match fs::read_to_string(path) {
        Ok(current) => Ok(trim_js_whitespace(&current).is_empty()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(source) => Err(write_error().with_source(source)),
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
    fs::create_dir_all(parent).map_err(|source| write_error().with_source(source))?;
    let _ = butler_platform::secure_fs::restrict_directory(parent);
    backup_private_text(data_root, path, prefix, text, now)?;
    fs::write(path, text.as_bytes()).map_err(|source| write_error().with_source(source))
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
    fs::create_dir_all(&directory).map_err(|source| write_error().with_source(source))?;
    let _ = butler_platform::secure_fs::restrict_directory(&directory);
    let stamp = now.replace([':', '.'], "-");
    let target = directory.join(format!("{prefix}-{stamp}.md"));
    fs::copy(source, target).map_err(|source| write_error().with_source(source))?;
    prune_backups(&directory, prefix)?;
    Ok(())
}

fn prune_backups(directory: &Path, prefix: &str) -> super::super::contracts::ProfileResult<()> {
    let entries = fs::read_dir(directory).map_err(|source| write_error().with_source(source))?;
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
        fs::remove_file(path).map_err(|source| write_error().with_source(source))?;
    }
    Ok(())
}

fn write_error() -> super::super::contracts::ProfileError {
    super::super::contracts::ProfileError::new(
        ProfileCode::PersonalizationWriteFailed,
        "Personalization could not be written.",
    )
}
