//! Checkpoint and immutable record inserts of turn transitions.

use super::*;

pub(super) fn checkpoint_for(
    turn_id: &str,
    revision: u64,
    state: TurnSemanticState,
) -> TurnCheckpoint {
    TurnCheckpoint {
        checkpoint_id: digest(&format!(
            "btcc-checkpoint.v1\0{turn_id}\0{revision}\0{}",
            state_text(state)
        )),
        checkpoint_revision: 1,
        semantic_state: state,
    }
}

pub(super) fn insert_checkpoint(
    connection: &Connection,
    turn_id: &str,
    revision: u64,
    checkpoint: &TurnCheckpoint,
) -> StorageResult<()> {
    connection.execute("INSERT INTO btcc_checkpoints (checkpoint_id, turn_id, turn_revision, \
        semantic_state, kind, checkpoint_revision, is_active) VALUES (?1, ?2, ?3, ?4, 'runtime', ?5, 1)",
        params![checkpoint.checkpoint_id, turn_id, revision, state_text(checkpoint.semantic_state),
            checkpoint.checkpoint_revision]).map_err(StorageError::sqlite)?;
    Ok(())
}

pub(super) fn insert_immutable_record(
    connection: &Connection,
    id: &str,
    kind: &str,
    sha: &str,
    content: &str,
) -> StorageResult<()> {
    connection
        .execute(
            "INSERT OR IGNORE INTO btcc_records (record_id, kind, sha256, content_json) \
        VALUES (?1, ?2, ?3, ?4)",
            params![id, kind, sha, content],
        )
        .map_err(StorageError::sqlite)?;
    let stored = connection
        .query_row(
            "SELECT kind, sha256, content_json FROM btcc_records WHERE record_id=?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(StorageError::sqlite)?;
    if stored != (kind.to_owned(), sha.to_owned(), content.to_owned()) {
        return Err(error(
            StorageCode::ImmutableRecordConflict,
            format!("Immutable BTCC record conflict: {id}"),
        ));
    }
    Ok(())
}
