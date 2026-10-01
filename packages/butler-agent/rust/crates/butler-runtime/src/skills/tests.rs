use std::io::Write;

use zip::write::SimpleFileOptions;

use super::*;

const SKILL: &str = "---\nname: imported\ndescription: Imported skill\napplicability: tests\nallowed-tools: read_file\ndispatch: direct\nreview: none\nreporting: concise\nuser-invocable: true\n---\nUse the imported skill.\n";

#[tokio::test]
async fn only_installed_status_receives_a_canonical_shell_quoted_command() {
    let root = std::env::temp_dir().join(format!("butler-skills-{}", uuid::Uuid::new_v4()));
    let resources = root.join("resources");
    let data = root.join("data");
    for directory in [
        resources.join("skills/restart"),
        data.join("skills/default/restart"),
    ] {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("SKILL.md"),
            SKILL.replace("name: imported", "name: restart"),
        )
        .unwrap();
    }
    let status = resources.join("skills/status");
    std::fs::create_dir_all(&status).unwrap();
    std::fs::write(
        status.join("SKILL.md"),
        SKILL.replace("name: imported", "name: status"),
    )
    .unwrap();
    let executable = root.join("native'agent");
    let expected = format!(
        "'{}'",
        executable.display().to_string().replace('\'', "'\\''")
    );
    let owner = Skills::for_installation(resources, data, executable);
    let catalog = owner.runtime_catalog(None).await.unwrap();
    assert_eq!(catalog.len(), 2);
    assert!(
        catalog
            .iter()
            .filter(|skill| skill.name == "restart")
            .all(|skill| skill.native_command.is_none())
    );
    let installed_status = catalog.iter().find(|skill| skill.name == "status").unwrap();
    assert_eq!(
        installed_status.native_command.as_deref(),
        Some(format!("{expected} status --json").as_str())
    );
    assert_eq!(
        installed_status.native_context_command.as_deref(),
        Some(format!("{expected} context status --json").as_str())
    );
    owner.close().await;
    let _ = std::fs::remove_dir_all(root);
}

fn archive(upload_root: &std::path::Path, path: &str, contents: &str) -> StagedSkillArchive {
    archive_entries(upload_root, &[(path, contents)])
}

fn archive_entries(upload_root: &std::path::Path, entries: &[(&str, &str)]) -> StagedSkillArchive {
    std::fs::create_dir_all(upload_root).unwrap();
    let destination = upload_root.join("archive.zip");
    let file = std::fs::File::create(destination).unwrap();
    let mut writer = zip::ZipWriter::new(file);
    for (path, contents) in entries {
        writer
            .start_file(*path, SimpleFileOptions::default())
            .unwrap();
        writer.write_all(contents.as_bytes()).unwrap();
    }
    writer.finish().unwrap();
    StagedSkillArchive::new("skill.zip".into(), upload_root.to_owned())
}

#[tokio::test]
async fn imports_lists_and_reopens_the_same_user_skill() {
    let root = std::env::temp_dir().join(format!("butler-skills-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    let data = root.join("data");
    let first = Skills::new(home.clone(), data.clone());
    let imported = first
        .import(
            archive(&root.join("upload"), "imported/SKILL.md", SKILL),
            None,
        )
        .await
        .unwrap();
    assert_eq!(imported.imported.len(), 1);
    let listed = first.runtime_catalog(None).await.unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|skill| skill.name.as_str())
            .collect::<Vec<_>>(),
        ["imported"]
    );
    first.close().await;
    let reopened = Skills::new(home, data);
    assert_eq!(
        reopened.runtime_catalog(None).await.unwrap()[0].name,
        "imported"
    );
    reopened.close().await;
    let _ = std::fs::remove_dir_all(root);
}

/// Security boundary: a skill archive with parent traversal (zip-slip) is
/// rejected without writing outside staging.
// test-category: security
#[tokio::test]
async fn rejects_parent_traversal_without_writing_outside_staging() {
    let root = std::env::temp_dir().join(format!("butler-skills-{}", uuid::Uuid::new_v4()));
    let owner = Skills::new(root.join("home"), root.join("data"));
    let result = owner
        .import(
            archive(&root.join("upload"), "../escape/SKILL.md", SKILL),
            None,
        )
        .await;
    assert!(matches!(result, Err(SkillError::ArchivePathInvalid)));
    assert!(!root.join("escape").exists());
    owner.close().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn imports_each_colliding_basename_and_keeps_the_later_candidate() {
    let root = std::env::temp_dir().join(format!("butler-skills-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let first = SKILL.replace("Imported skill", "First candidate");
    let second = SKILL.replace("Imported skill", "Second candidate");
    let path = archive_entries(
        &root.join("upload"),
        &[
            ("one/imported/SKILL.md", &first),
            ("two/imported/SKILL.md", &second),
        ],
    );
    let owner = Skills::new(root.join("home"), root.join("data"));
    let imported = owner.import(path, None).await.unwrap();
    assert_eq!(imported.imported.len(), 2);
    let catalog = owner.runtime_catalog(None).await.unwrap();
    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0].description, imported.imported[1].description);
    owner.close().await;
    let _ = std::fs::remove_dir_all(root);
}
