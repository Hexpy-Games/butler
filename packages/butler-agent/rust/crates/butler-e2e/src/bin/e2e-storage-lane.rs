//! Dev-only companion exercising the real App lane with deterministic ordering.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "fixture assertions"
)]
use butler_gateway::gateway::LaneFixture;

fn main() {
    earlier_read_survives_failed_begin();
    barrier_survives_later_failure();
}

fn earlier_read_survives_failed_begin() {
    let mut lane = LaneFixture::new().unwrap();
    let read = lane.stage("PRAGMA query_only=ON");
    let write = lane.admit(false, false, "CREATE TABLE forbidden(id)");
    lane.finish();
    assert!(read.try_recv().unwrap().is_ok());
    assert!(write.try_recv().unwrap().is_err());
    assert!(lane.is_autocommit());
}

fn barrier_survives_later_failure() {
    for later_begin_failure in [true, false] {
        let mut lane = LaneFixture::new().unwrap();
        lane.sql(
            "PRAGMA foreign_keys=ON;
            CREATE TABLE parent(id PRIMARY KEY);
            CREATE TABLE child(id REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);",
        )
        .unwrap();
        lane.begin().unwrap();
        let write = lane.stage("INSERT INTO parent VALUES(1)");
        let barrier = lane.admit(true, true, "SELECT 1");
        assert!(
            write.try_recv().unwrap().is_ok(),
            "barrier must complete prior writes"
        );
        assert!(lane.is_synced());
        assert!(
            barrier.try_recv().is_err(),
            "barrier starts a fresh completion group"
        );
        let sql = if later_begin_failure {
            lane.sql("PRAGMA query_only=ON").unwrap();
            "INSERT INTO parent VALUES(2)"
        } else {
            "INSERT INTO child VALUES(2)"
        };
        let failed = lane.admit(false, false, sql);
        lane.finish();
        assert!(failed.try_recv().unwrap().is_err());
        assert!(
            write.try_recv().is_err(),
            "completion must be sent only once"
        );
        assert_eq!(barrier.try_recv().unwrap().is_ok(), later_begin_failure);
        if !lane.is_autocommit() {
            lane.sql("ROLLBACK").unwrap();
        }
        assert_eq!(lane.query_count("SELECT COUNT(*) FROM parent").unwrap(), 1);
    }
}
