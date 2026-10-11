//! Correction failures preserve the original inode and still reach gateway readiness.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use super::super::{offline, seed};
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use butler_platform::secure_fs;
use rusqlite::Connection;
use std::{collections::BTreeMap, path::Path};

pub(super) async fn exercise(
    s: &mut Scenario,
    path: &Path,
    baseline: &Path,
    active: &[String],
    snapshot: &BTreeMap<String, (u64, String)>,
) -> Result<(), HarnessError> {
    for (point, expected) in [
        ("correction_drain", "reclaiming"),
        ("correction_counts", "failed_copy"),
    ] {
        super::super::restore(path, baseline)?;
        let original = secure_fs::identity(&std::fs::metadata(path)?).id;
        let marker = s.sandbox.root.join(point);
        s.agent.launch.set_env("BUTLER_E2E_FILE_FAULT", point);
        s.agent
            .launch
            .set_env("BUTLER_E2E_FILE_FAULT_MARKER", marker.to_string_lossy());
        s.gw = s.agent.start_again().await?;
        assert!(marker.exists(), "fault was not reached: {point}");
        assert_eq!(super::state(path)?, expected);
        intact(s, path, original, active, snapshot).await?;
        s.agent.launch.remove_env("BUTLER_E2E_FILE_FAULT");
        s.agent.launch.remove_env("BUTLER_E2E_FILE_FAULT_MARKER");
        s.gw = s.agent.start_again().await?;
        assert!(s.gw.healthy().await);
        if point == "correction_drain" {
            super::verify(path, active, snapshot).await?;
        } else {
            assert_eq!(super::state(path)?, "failed_copy");
            assert_eq!(secure_fs::identity(&std::fs::metadata(path)?).id, original);
        }
        s.agent.terminate().await?;
    }
    super::super::restore(path, baseline)?;
    let original = secure_fs::identity(&std::fs::metadata(path)?).id;
    s.agent
        .launch
        .set_env("BUTLER_E2E_DISK_AVAILABLE_BYTES", "unavailable");
    s.gw = s.agent.start_again().await?;
    assert_eq!(super::state(path)?, "failed_space");
    intact(s, path, original, active, snapshot).await?;
    s.agent.launch.remove_env("BUTLER_E2E_DISK_AVAILABLE_BYTES");
    // Persisted skip plus a same-file link, with no temporary copy.
    let link = path.with_extension("sqlite.precompact");
    std::fs::hard_link(path, &link)?;
    assert!(!path.with_extension("sqlite.compact-tmp").exists());
    s.gw = s.agent.start_again().await?;
    assert!(s.gw.healthy().await);
    assert!(!link.exists());
    assert_eq!(super::state(path)?, "failed_space");
    intact(s, path, original, active, snapshot).await?;
    // Cleanup errors (including opened()) must also leave a serving original.
    let tmp = path.with_extension("sqlite.compact-tmp");
    std::fs::create_dir(&tmp)?;
    s.gw = s.agent.start_again().await?;
    assert!(tmp.exists());
    assert_eq!(super::state(path)?, "failed_correction");
    intact(s, path, original, active, snapshot).await?;
    std::fs::remove_dir(&tmp)?;
    super::super::restore(path, baseline)?;
    let original = secure_fs::identity(&std::fs::metadata(path)?).id;
    s.agent
        .launch
        .set_env("BUTLER_E2E_ABORT_POINT", "after_link");
    for attempt in 1..=2 {
        assert!(s.agent.start_again().await.is_err());
        s.agent.reap();
        assert_eq!(super::state(path)?, "compacting");
        assert_eq!(
            Connection::open(path)?.query_row(
                "SELECT attempts FROM agent_storage_corrections",
                [],
                |r| r.get::<_, u32>(0)
            )?,
            attempt
        );
        assert_eq!(secure_fs::identity(&std::fs::metadata(path)?).id, original);
    }
    s.agent.launch.remove_env("BUTLER_E2E_ABORT_POINT");
    s.gw = s.agent.start_again().await?;
    assert_eq!(super::state(path)?, "failed_copy");
    assert!(!link.exists());
    intact(s, path, original, active, snapshot).await
}

async fn intact(
    s: &mut Scenario,
    path: &Path,
    original: Option<secure_fs::FileId>,
    active: &[String],
    snapshot: &BTreeMap<String, (u64, String)>,
) -> Result<(), HarnessError> {
    assert!(s.gw.healthy().await);
    assert_eq!(secure_fs::identity(&std::fs::metadata(path)?).id, original);
    assert_eq!(seed::admitted(path, "corr-active")?, active);
    super::super::assert_snapshot(snapshot, &offline(path, seed::snapshot).await?);
    s.agent.terminate().await
}
