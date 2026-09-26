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
        data.join("skills/restart"),
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
    let owner = NativeSkills::for_installation(resources, data, executable);
    let catalog = owner.runtime_catalog(None).await.unwrap();
    assert_eq!(catalog.len(), 3);
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
    let first = NativeSkills::new(home.clone(), data.clone());
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
    let reopened = NativeSkills::new(home, data);
    assert_eq!(
        reopened.runtime_catalog(None).await.unwrap()[0].name,
        "imported"
    );
    reopened.close().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn rejects_parent_traversal_without_writing_outside_staging() {
    let root = std::env::temp_dir().join(format!("butler-skills-{}", uuid::Uuid::new_v4()));
    let owner = NativeSkills::new(root.join("home"), root.join("data"));
    let result = owner
        .import(
            archive(&root.join("upload"), "../escape/SKILL.md", SKILL),
            None,
        )
        .await;
    assert!(matches!(
        result,
        Err(SkillError {
            code: "skill_archive_path_invalid",
            ..
        })
    ));
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
    let owner = NativeSkills::new(root.join("home"), root.join("data"));
    let imported = owner.import(path, None).await.unwrap();
    assert_eq!(imported.imported.len(), 2);
    let catalog = owner.runtime_catalog(None).await.unwrap();
    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0].description, imported.imported[1].description);
    owner.close().await;
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn unadmitted_archive_drop_cleans_its_staging_root() {
    let root = std::env::temp_dir().join(format!("butler-upload-{}", uuid::Uuid::new_v4()));
    let staged = archive(&root, "imported/SKILL.md", SKILL);
    assert!(staged.path().is_file());
    drop(staged);
    assert!(!root.exists());
}

#[tokio::test]
async fn cancelled_caller_leaves_admitted_archive_owned_by_blocking_job() {
    let root = std::env::temp_dir().join(format!("butler-upload-{}", uuid::Uuid::new_v4()));
    let staged = archive(&root, "imported/SKILL.md", SKILL);
    let archive_path = staged.path().to_owned();
    let owner = NativeSkills::new(root.join("home"), root.join("data"));
    let permit = owner.permit().await.unwrap();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let caller = tokio::spawn(async move {
        blocking(permit, move || {
            let _ = started_tx.send(());
            let _ = release_rx.recv();
            drop(staged);
            Ok(())
        })
        .await
    });
    started_rx.await.unwrap();
    caller.abort();
    assert!(archive_path.is_file());
    release_tx.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while root.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    owner.close().await;
}

#[tokio::test]
async fn projects_loaded_names_from_the_matching_final_result_turn() {
    let root = std::env::temp_dir().join(format!("butler-skills-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("data/transcripts")).unwrap();
    let mut skill_names = vec![
        serde_json::json!(" native-smoke-skill "),
        serde_json::json!("native-smoke-skill"),
        serde_json::json!("not a token"),
    ];
    skill_names.extend((0..60).map(|index| serde_json::json!(format!("skill-{index}"))));
    let transcript = [
            serde_json::json!({"kind":"outbound","payload":{"metadata":{"kind":"final_result","turnId":"older","loadedSkillNames":["old"]}}}).to_string(),
            serde_json::json!({"kind":"outbound","payload":{"metadata":{"kind":"final_result","turnId":"current","loadedSkillNames":skill_names}}}).to_string(),
            "x".repeat(1024 * 1024 + 1),
        ].join("\n");
    std::fs::write(
        root.join("data/transcripts/butler_app-general.jsonl"),
        transcript,
    )
    .unwrap();
    let owner = NativeSkills::new(root.join("home"), root.join("data"));
    let names = owner
        .loaded_names(vec![(
            "butler/app-general".into(),
            Some("current".into()),
            None,
        )])
        .await
        .unwrap();
    assert_eq!(names[0].len(), 48);
    assert_eq!(names[0][0], "native-smoke-skill");
    assert_eq!(names[0][47], "skill-46");
    owner.close().await;
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn falls_back_to_legacy_session_only_when_runtime_has_no_projection() {
    let root = std::env::temp_dir().join(format!("butler-skills-{}", uuid::Uuid::new_v4()));
    let transcripts = root.join("data/transcripts");
    std::fs::create_dir_all(&transcripts).unwrap();
    let event = serde_json::json!({
        "kind":"system",
        "payload":{
            "category":"context.skills.loaded",
            "details":{"turnId":"current","skillNames":["legacy-skill"]}
        }
    });
    std::fs::write(transcripts.join("legacy.jsonl"), event.to_string()).unwrap();
    let owner = NativeSkills::new(root.join("home"), root.join("data"));
    let fallback = owner
        .loaded_names(vec![(
            "runtime".into(),
            Some("current".into()),
            Some("legacy".into()),
        )])
        .await
        .unwrap();
    assert_eq!(fallback, vec![vec!["legacy-skill"]]);

    let empty = serde_json::json!({
        "kind":"outbound",
        "payload":{"metadata":{"kind":"final_result","turnId":"current","loadedSkillNames":[]}}
    });
    std::fs::write(transcripts.join("runtime.jsonl"), empty.to_string()).unwrap();
    let explicit_empty = owner
        .loaded_names(vec![(
            "runtime".into(),
            Some("current".into()),
            Some("legacy".into()),
        )])
        .await
        .unwrap();
    assert_eq!(explicit_empty, vec![Vec::<String>::new()]);
    owner.close().await;
    let _ = std::fs::remove_dir_all(root);
}
