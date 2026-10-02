//! Fixture-only admission gate: commit one retirement lease, then refuse the
//! next until the test restarts the service. Audit rows commit with the lease,
//! so a failed/blocked DROP cannot consume the gate or fabricate progress.
use rusqlite::{Connection, OpenFlags};
use std::{
    path::Path,
    time::{Duration, Instant},
};

pub(super) struct RetirementGate(Connection);

impl RetirementGate {
    pub(super) fn install(data: &Path) -> Self {
        let path = data.join("cognition/consolidation/locks/consolidation.lock.coord.sqlite");
        let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
        db.execute_batch(
            "CREATE TABLE fixture_retirement_passes (
                pass INTEGER PRIMARY KEY, owner_nonce TEXT NOT NULL UNIQUE, pid INTEGER NOT NULL);
             CREATE TRIGGER fixture_retirement_hold BEFORE UPDATE OF last_owner_json
             ON memory_write_gate
             WHEN json_extract(NEW.last_owner_json, '$.purpose') = 'alias_index_retirement'
              AND EXISTS(SELECT 1 FROM fixture_retirement_passes)
             BEGIN SELECT RAISE(ABORT, 'fixture retirement admission held'); END;
             CREATE TRIGGER fixture_retirement_audit AFTER UPDATE OF last_owner_json
             ON memory_write_gate
             WHEN json_extract(NEW.last_owner_json, '$.purpose') = 'alias_index_retirement'
             BEGIN
                INSERT INTO fixture_retirement_passes(owner_nonce,pid)
                VALUES(json_extract(NEW.last_owner_json, '$.owner_nonce'),
                       json_extract(NEW.last_owner_json, '$.pid'));
             END;",
        )
        .unwrap();
        Self(db)
    }

    pub(super) fn passes(&self) -> Vec<(String, u32)> {
        self.0
            .prepare("SELECT owner_nonce,pid FROM fixture_retirement_passes ORDER BY pass")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    pub(super) async fn until_passes(&self, expected: usize) -> Vec<(String, u32)> {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let passes = self.passes();
            if passes.len() == expected {
                return passes;
            }
            assert!(
                passes.len() < expected,
                "extra retirement leases: {passes:?}"
            );
            assert!(Instant::now() < deadline, "retirement lease did not commit");
            tokio::task::yield_now().await;
        }
    }

    pub(super) fn resume(&self) {
        self.0
            .execute_batch("DROP TRIGGER fixture_retirement_hold")
            .unwrap();
    }
}
