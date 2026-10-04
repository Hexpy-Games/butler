//! Complete, freshly inspected private writes must not launch a shell per file.
use std::{fs, io::Write, time::Instant};

use butler_e2e::e2e::{HarnessError, sandbox::Sandbox};
use butler_platform::secure_fs::{create_private_dir, is_private, replace_private};

#[test]
fn private_replacements_keep_complete_content_and_live_permissions() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut sandbox = Sandbox::new("WIN-PRIVATE-METADATA")?;
    let directory = sandbox.data.join("private");
    // Resolve process identity once, before the repeated filesystem work.
    create_private_dir(&directory)?;
    assert_eq!(is_private(&directory), Some(true));
    let started = Instant::now();
    for revision in 0..2 {
        for index in 0..16 {
            let path = directory.join(format!("record-{index:02}.json"));
            let content =
                format!("{{\"index\":{index},\"revision\":{revision},\"text\":\"보고서\"}}");
            replace_private(
                &path,
                |file| file.write_all(content.as_bytes()),
                std::convert::identity,
            )?;
            assert_eq!(is_private(&path), Some(true), "{}", path.display());
            assert_eq!(fs::read_to_string(&path)?, content);
        }
    }
    let mut entries = fs::read_dir(&directory)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort();
    assert_eq!(entries.len(), 16);
    for (index, path) in entries.iter().enumerate() {
        let latest = format!("{{\"index\":{index},\"revision\":1,\"text\":\"보고서\"}}");
        assert_eq!(fs::read_to_string(path)?, latest);
        assert_eq!(is_private(path), Some(true));
    }
    butler_e2e::assert_wall_clock_budget!(
        started.elapsed(),
        std::time::Duration::from_secs(5),
        "32 complete private replacements and 48 live ACL inspections",
    );
    sandbox.mark_success();
    Ok(())
}
