//! The authority contract pins the platform sync policy it relies on.
use super::*;

pub(super) async fn assert_scoped_sync(storage: &BtccStorage) {
    storage
        .execute(|db| {
            for previous in [false, true] {
                db.pragma_update(None, "fullfsync", previous).unwrap();
                for fail in [false, true] {
                    let result = butler_platform::sqlite::with_fullfsync(db, |db| {
                        let active: bool = db
                            .pragma_query_value(None, "fullfsync", |r| r.get(0))
                            .unwrap();
                        assert_eq!(
                            active,
                            previous || butler_platform::sqlite::FULLFSYNC_REQUIRED
                        );
                        if fail {
                            Err("transaction failed")
                        } else {
                            Ok(())
                        }
                    })
                    .unwrap();
                    assert_eq!(result.is_err(), fail);
                    let restored: bool = db
                        .pragma_query_value(None, "fullfsync", |r| r.get(0))
                        .unwrap();
                    assert_eq!(restored, previous);
                }
            }
            db.pragma_update(None, "fullfsync", false).unwrap();
            Ok(())
        })
        .await
        .unwrap();
}
