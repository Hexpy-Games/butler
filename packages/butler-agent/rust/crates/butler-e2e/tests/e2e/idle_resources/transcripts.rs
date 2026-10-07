//! Real synthetic JSONL bytes, including two unfinished App projections.
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use butler_platform::sqlite;
use rusqlite::params;
use std::{fs, io::Write, path::Path, time::Duration};

const FILES: u64 = 2_440;
const BYTES: u64 = 1_500_000_000;
const LARGEST: u64 = 290_000_000;

pub(super) fn seed(data: &Path) -> Result<(), HarnessError> {
    let root = data.join("transcripts");
    // Replace the initial synthetic fixture transcript corpus before sizing it.
    if root.exists() {
        fs::remove_dir_all(&root)?;
    }
    fs::create_dir_all(&root)?;
    let db = sqlite::open(data.join("app-server/butler-client.sqlite"))?;
    db.execute("INSERT INTO chats(id,title,kind,pinned,archived,created_at,updated_at) VALUES('project-butler','Idle project','chat',0,0,'2026-01-01','2026-01-01')", [])?;
    let rest = BYTES - LARGEST - 100_000_000;
    for index in 0..FILES {
        let (chat, size) = match index {
            0 => ("general".to_owned(), LARGEST),
            1 => ("project-butler".to_owned(), 100_000_000),
            _ => (
                format!("idle-{index}"),
                rest / (FILES - 2) + u64::from(index - 2 < rest % (FILES - 2)),
            ),
        };
        let path = root.join(format!("butler_app-{chat}.jsonl"));
        write_record(&path, size)?;
        if index < 2 {
            seed_open_turn(&db, &path, &chat, size)?;
        }
    }
    assert_sizes(data)?;
    Ok(())
}

fn write_record(path: &Path, size: u64) -> Result<(), HarnessError> {
    let prefix = b"{\"eventId\":\"idle-seed\",\"sessionId\":\"idle\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"kind\":\"inbound\",\"transport\":\"telegram\",\"payload\":{\"text\":\"";
    let suffix = b"\"}}\n";
    let mut file = fs::File::create(path)?;
    file.write_all(prefix)?;
    let chunk = vec![b'x'; 1_000_000];
    let mut remaining = size - prefix.len() as u64 - suffix.len() as u64;
    while remaining > 0 {
        let count = usize::try_from(remaining.min(chunk.len() as u64)).expect("bounded chunk");
        file.write_all(&chunk[..count])?;
        remaining -= count as u64;
    }
    file.write_all(suffix)?;
    Ok(())
}

fn seed_open_turn(
    db: &rusqlite::Connection,
    path: &Path,
    chat: &str,
    size: u64,
) -> Result<(), HarnessError> {
    let metadata = fs::metadata(path)?;
    let (device, inode) = butler_platform::secure_fs::identity(&metadata)
        .id
        .map_or((0, 0), |id| (id.device, id.inode));
    let modified = metadata
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(std::io::Error::other)?
        .as_secs_f64()
        * 1000.0;
    let mut anchor = vec![b'x'; 60];
    anchor.extend_from_slice(b"\"}}\n");
    db.execute("INSERT INTO turns(id,chat_id,state,safe_status_label,created_at,updated_at) VALUES(?1,?2,'streaming','Streaming','2026-01-01','2026-01-01')", params![format!("idle-open-{chat}"), chat])?;
    db.execute("INSERT INTO app_transcript_projection_checkpoints(chat_id,session_id,transcript_path,file_device,file_inode,projected_bytes,modified_at_ms,trailing_text,boundary_anchor_text,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'',?8,'2026-01-01')", params![chat,format!("butler/app-{chat}"),path.to_string_lossy(),device,inode,size,modified,STANDARD.encode(anchor)])?;
    Ok(())
}

pub(super) fn assert_sizes(data: &Path) -> Result<(), HarnessError> {
    let mut sizes = Vec::new();
    for entry in fs::read_dir(data.join("transcripts"))? {
        let entry = entry?;
        if entry.path().extension().is_some_and(|ext| ext == "jsonl") {
            sizes.push(entry.metadata()?.len());
        }
    }
    assert_eq!(sizes.len() as u64, FILES);
    assert_eq!(sizes.iter().sum::<u64>(), BYTES);
    assert_eq!(sizes.iter().max(), Some(&LARGEST));
    let db = sqlite::open(data.join("app-server/butler-client.sqlite"))?;
    let open: u64 = db.query_row(
        "SELECT COUNT(*) FROM turns WHERE id LIKE 'idle-open-%' AND state='streaming'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(open, 2, "fixture must retain unfinished turns during idle");
    eprintln!("PERF-IDLE transcripts={FILES} bytes={BYTES} largest={LARGEST} open_turns={open}");
    Ok(())
}

/// A filesystem append must advance without a foreground projection request.
pub(super) async fn assert_append_wakes(s: &Scenario) -> Result<(), HarnessError> {
    let path = s.sandbox.data.join("transcripts/butler_app-general.jsonl");
    let record = b"{\"eventId\":\"idle-after\",\"sessionId\":\"butler/app-general\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"kind\":\"inbound\",\"transport\":\"telegram\",\"payload\":{\"text\":\"latest\"}}\n";
    fs::OpenOptions::new()
        .append(true)
        .open(&path)?
        .write_all(record)?;
    let expected = LARGEST + record.len() as u64;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let db = sqlite::open_with_flags(
            s.sandbox.data.join("app-server/butler-client.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        let cursor: u64 = db.query_row("SELECT projected_bytes FROM app_transcript_projection_checkpoints WHERE chat_id='general'", [], |row| row.get(0))?;
        if cursor == expected {
            return Ok(());
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "append notification did not project latest record: {cursor}/{expected}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
