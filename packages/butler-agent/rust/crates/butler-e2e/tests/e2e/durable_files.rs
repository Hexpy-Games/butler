//! Real requests and interrupted disk states for multi-step file replacements.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Cursor, Write},
    path::Path,
    time::{Duration, Instant, SystemTime},
};
use zip::{ZipWriter, write::SimpleFileOptions};

fn fault(id: &str, point: &str) -> Result<Setup, HarnessError> {
    let setup = Setup::new(id)?;
    let marker = setup.sandbox.root.join("file-fault");
    Ok(setup
        .env("BUTLER_E2E_FILE_FAULT", point)
        .env("BUTLER_E2E_FILE_FAULT_MARKER", marker.display().to_string()))
}

fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        zip.start_file(*name, SimpleFileOptions::default()).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

const SKILL: &[u8] = b"---\nname: durable\ndescription: Complete skill\n---\nNew instructions\n";

#[tokio::test]
async fn lease_less_claim_is_recovered_after_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("DURABLE-QUEUE")?;
    let processing = setup.sandbox.data.join("runtime/inbound-events/processing");
    fs::create_dir_all(&processing)?;
    let path = processing.join("crash.json");
    fs::write(
        &path,
        serde_json::to_vec(&json!({"version":1,"queueId":"crash",
        "envelope":{"eventId":"crash","transport":"unsupported","accountId":"test",
            "peer":{},"message":{"id":"crash","text":"preserve me","timestamp":"2026-09-30T00:00:00Z"}},
        "enqueuedAt":"2026-09-30T00:00:00Z","attempts":0,"metadata":{}}))?,
    )?;
    fs::File::options().write(true).open(&path)?.set_times(
        fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(17 * 60)),
    )?;
    let s = setup.start().await?;
    let deadline = Instant::now() + Duration::from_secs(5);
    while path.exists() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(!path.exists(), "lease-less processing record stranded");
    let root = processing.parent().unwrap();
    assert!(
        ["pending", "failed", "processed"]
            .iter()
            .any(|state| root.join(state).join("crash.json").exists())
    );
    s.finish().await
}

fn wallpaper(root: &Path, folder: &str, shader: &str) -> std::io::Result<()> {
    let path = root.join(folder);
    fs::create_dir_all(&path)?;
    fs::write(
        path.join("wallpaper.json"),
        json!({"id":"user.durable",
        "name":{"en":"Durable","ko":"보존"},"version":"1.0.0","engine":1,
        "motion":"animated","image":"none","params":[]})
        .to_string(),
    )?;
    fs::write(path.join("shader.frag"), shader)
}

#[tokio::test]
async fn sweep_restores_the_copy_between_legacy_renames() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("DURABLE-WALL")?;
    let root = setup.sandbox.data.join("wallpapers");
    wallpaper(&root, ".trash-crash", "OLD_COMPLETE")?;
    wallpaper(&root, ".import-crash", "NEW_COMPLETE")?;
    let s = setup.start().await?;
    assert_eq!(
        fs::read_to_string(root.join("user.durable/shader.frag")).unwrap_or_default(),
        "OLD_COMPLETE"
    );
    assert!(!root.join(".trash-crash").exists());
    assert!(!root.join(".import-crash").exists());
    s.finish().await
}

#[tokio::test]
async fn failed_skill_copy_preserves_the_installed_tree() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = fault("DURABLE-SKILL-COPY", "skill_copy")?;
    let installed = setup.sandbox.data.join("skills/default/durable");
    fs::create_dir_all(&installed)?;
    fs::write(installed.join("SKILL.md"), b"OLD_COMPLETE")?;
    fs::write(installed.join("resource.txt"), b"OLD_RESOURCE")?;
    let s = setup.start().await?;
    let zip = archive(&[
        ("durable/SKILL.md", SKILL),
        ("durable/new.txt", b"NEW_RESOURCE"),
    ]);
    let reply =
        s.gw.upload_file("/skills/import", "skill.zip", "application/zip", &zip)
            .await?;
    assert_eq!(reply.status, 500, "{}", reply.text);
    assert!(s.sandbox.root.join("file-fault").exists());
    assert_eq!(fs::read(installed.join("SKILL.md"))?, b"OLD_COMPLETE");
    assert_eq!(fs::read(installed.join("resource.txt"))?, b"OLD_RESOURCE");
    assert!(!installed.join("new.txt").exists());
    s.finish().await
}

#[tokio::test]
async fn broken_sibling_does_not_fail_a_committed_skill_import() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("DURABLE-SKILL-SIBLING")?.start().await?;
    let root = s.sandbox.data.join("skills/default");
    fs::create_dir_all(root.join("broken/SKILL.md"))?;
    let zip = archive(&[("durable/SKILL.md", SKILL)]);
    let reply =
        s.gw.upload_file("/skills/import", "skill.zip", "application/zip", &zip)
            .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    assert_eq!(reply.data()["imported"].as_array().map(Vec::len), Some(1));
    assert_eq!(fs::read(root.join("durable/SKILL.md"))?, SKILL);
    s.finish().await
}

fn files(root: &Path) -> Vec<std::path::PathBuf> {
    fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .collect()
}

#[tokio::test]
async fn failed_upload_does_not_publish_bytes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = fault("DURABLE-UPLOAD", "message_upload")?.start().await?;
    let root = s.sandbox.data.join("app-server/message-files");
    let before = files(&root);
    let reply =
        s.gw.upload("note.txt", "text/plain", b"COMPLETE_BYTES", Some("general"))
            .await?;
    assert_eq!(reply.status, 500, "{}", reply.text);
    assert!(s.sandbox.root.join("file-fault").exists());
    assert_eq!(files(&root), before, "failed upload published an orphan");
    let reply =
        s.gw.upload("note.txt", "text/plain", b"COMPLETE_BYTES", Some("general"))
            .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let id = reply.data()["file"]["file_id"].as_str().unwrap();
    assert_eq!(
        s.gw.download(&format!("/message-files/{id}")).await?,
        (200, b"COMPLETE_BYTES".to_vec())
    );
    s.finish().await
}

#[tokio::test]
async fn interrupted_transcript_write_retains_the_whole_outbound_pair() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let s = fault("DURABLE-TRANSCRIPT", "transcript_pair")?
        .cassette("TURN-01")
        .start()
        .await?;
    let _ = s.turn("general", "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.").await?;
    let mut events = Vec::<Value>::new();
    for path in files(&s.sandbox.data.join("transcripts")) {
        assert_eq!(
            butler_platform::secure_fs::is_owner_only(&fs::metadata(&path)?),
            butler_platform::secure_fs::OWNER_ONLY.then_some(true),
            "transcript permissions"
        );
        events.extend(
            fs::read_to_string(path)?
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).unwrap()),
        );
    }
    assert!(
        events.iter().any(|event| event["kind"] == "outbound"),
        "no outbound persisted"
    );
    for pair in events.windows(2) {
        if pair[0]["kind"] == "outbound" {
            assert_eq!(pair[1]["kind"], "delivery", "orphan outbound: {}", pair[0]);
            assert_eq!(
                pair[0]["payload"]["actionId"],
                pair[1]["payload"]["actionId"]
            );
        }
    }
    assert!(
        events
            .last()
            .is_none_or(|event| event["kind"] != "outbound")
    );
    assert!(s.sandbox.root.join("file-fault").exists());
    s.finish().await
}

#[tokio::test]
async fn previous_wallpaper_survives_retention_failure_and_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = fault("DURABLE-WALL-PREVIOUS", "wallpaper_previous")?;
    let root = setup.sandbox.data.join("wallpapers");
    wallpaper(&root, "user.durable", "OLD_COMPLETE")?;
    wallpaper(&root, ".previous/user.durable", "ANCIENT_COMPLETE")?;
    let manifest = fs::read(root.join("user.durable/wallpaper.json"))?;
    let shader = b"void main(){fragColor=vec4(1.);}";
    let zip = archive(&[("wallpaper.json", &manifest), ("shader.frag", shader)]);
    let mut s = setup.start().await?;
    let reply =
        s.gw.upload_file(
            "/wallpaper-modules/import?replace=1",
            "wall.zip",
            "application/zip",
            &zip,
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    assert!(s.sandbox.root.join("file-fault").exists());
    assert_eq!(fs::read(root.join("user.durable/shader.frag"))?, shader);
    assert_eq!(
        fs::read(root.join(".previous/user.durable/shader.frag"))?,
        b"ANCIENT_COMPLETE"
    );
    assert!(files(&root).iter().any(|path| {
        path.file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(".trash-")
            && fs::read(path.join("shader.frag")).is_ok_and(|bytes| bytes == b"OLD_COMPLETE")
    }));
    s.restart().await?;
    assert_eq!(
        fs::read(root.join(".previous/user.durable/shader.frag"))?,
        b"ANCIENT_COMPLETE"
    );
    assert_eq!(fs::read(root.join("user.durable/shader.frag"))?, shader);
    let removed = s.gw.delete("/wallpaper-modules/user.durable").await?;
    assert_eq!(removed.status, 200, "{}", removed.text);
    s.restart().await?;
    assert!(
        !root.join("user.durable").exists(),
        "sweep resurrected a deleted module"
    );
    s.finish().await
}

#[tokio::test]
async fn same_name_imports_publish_complete_trees_and_hide_staging() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("DURABLE-SKILL-CONCURRENT")?.start().await?;
    let root = s.sandbox.data.join("skills/default");
    fs::create_dir_all(root.join(".import-ghost"))?;
    fs::write(
        root.join(".import-ghost/SKILL.md"),
        b"---\nname: ghost\n---\nPartial\n",
    )?;
    let first = archive(&[
        ("durable/SKILL.md", SKILL),
        ("durable/first.txt", b"FIRST_COMPLETE"),
    ]);
    let second_skill = b"---\nname: durable\ndescription: Second skill\n---\nSecond instructions\n";
    let second = archive(&[
        ("durable/SKILL.md", second_skill),
        ("durable/second.txt", b"SECOND_COMPLETE"),
    ]);
    let (first, second) = tokio::join!(
        s.gw.upload_file("/skills/import", "first.zip", "application/zip", &first),
        s.gw.upload_file("/skills/import", "second.zip", "application/zip", &second)
    );
    assert_eq!(first?.status, 201);
    assert_eq!(second?.status, 201);
    let final_skill = fs::read(root.join("durable/SKILL.md"))?;
    if final_skill == SKILL {
        assert_eq!(fs::read(root.join("durable/first.txt"))?, b"FIRST_COMPLETE");
        assert!(!root.join("durable/second.txt").exists());
    } else {
        assert_eq!(final_skill, second_skill);
        assert_eq!(
            fs::read(root.join("durable/second.txt"))?,
            b"SECOND_COMPLETE"
        );
        assert!(!root.join("durable/first.txt").exists());
    }
    let listed = s.gw.get("/skills").await?;
    assert_eq!(listed.status, 200, "{}", listed.text);
    assert!(
        !listed.text.contains("ghost"),
        "temporary skill leaked into catalog"
    );
    s.finish().await
}
