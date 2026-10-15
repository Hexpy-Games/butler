//! Settled history in the very transcript that receives the sampled approvals.
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::HarnessError;
use rusqlite::{Connection, params};
use std::{
    fs,
    io::{BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

pub(super) struct Expected {
    path: PathBuf,
    bytes: u64,
    line: Vec<u8>,
    chat: String,
}

pub(super) fn seed(data: &Path, chat: &str) -> Result<Expected, HarnessError> {
    let session = format!("butler/app-{chat}");
    let path = data
        .join("transcripts")
        .join(format!("butler_app-{chat}.jsonl"));
    let mut line = serde_json::to_vec(&serde_json::json!({
        "eventId":"historical-status", "sessionId":session, "kind":"session_status",
        "timestamp":"2026-01-01T00:00:00Z",
        "payload":{"role":"agent","state":"closed","reason":"completed"},
        "metadata":{"padding":"x".repeat(1800)}
    }))?;
    line.push(b'\n');
    let rows = 290_000_000 / line.len() as u64 + 1;
    let mut output = BufWriter::new(fs::File::create(&path)?);
    for _ in 0..rows {
        output.write_all(&line)?;
    }
    output.flush()?;
    let bytes = rows * line.len() as u64;
    let identity = butler_platform::secure_fs::identity(&fs::metadata(&path)?);
    let (device, inode) = identity.id.map_or((0, 0), |id| (id.device, id.inode));
    let db = Connection::open(data.join("app-server/butler-client.sqlite"))?;
    db.execute(
        "INSERT OR REPLACE INTO app_transcript_projection_checkpoints(
        chat_id,session_id,transcript_path,file_device,file_inode,projected_bytes,
        modified_at_ms,trailing_text,boundary_anchor_text,updated_at)
        VALUES(?1,?2,?3,?4,?5,?6,0,'',?7,'now')",
        params![
            chat,
            session,
            path.to_string_lossy(),
            device,
            inode,
            bytes,
            STANDARD.encode(&line[line.len() - 64..])
        ],
    )?;
    eprintln!("APPROVAL-ACTIVE-TRANSCRIPT bytes={bytes}");
    Ok(Expected {
        path,
        bytes,
        line,
        chat: chat.to_owned(),
    })
}

pub(super) fn assert_complete(data: &Path, expected: &Expected) -> Result<(), HarnessError> {
    let mut file = fs::File::open(&expected.path)?;
    assert!(
        file.metadata()?.len() > expected.bytes,
        "sampled turns append to the large transcript"
    );
    for offset in [0, expected.bytes - expected.line.len() as u64] {
        file.seek(SeekFrom::Start(offset))?;
        let mut line = vec![0; expected.line.len()];
        file.read_exact(&mut line)?;
        assert_eq!(line, expected.line, "retained historical bytes");
    }
    let db = Connection::open(data.join("app-server/butler-client.sqlite"))?;
    let projected: u64 = db.query_row(
        "SELECT projected_bytes FROM app_transcript_projection_checkpoints WHERE chat_id=?1",
        [&expected.chat],
        |row| row.get(0),
    )?;
    assert_eq!(
        projected,
        file.metadata()?.len(),
        "complete current projection"
    );
    Ok(())
}
