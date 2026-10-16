//! Test-only drivers: every notification comes from an actual filesystem mutation.
use super::{Change, Config, NAME_CHANGES, native::Reader};
use std::{fs, io};

pub(super) fn exercise(
    reader: &mut Reader,
    kind: &str,
    pending: &mut Vec<Change>,
) -> io::Result<()> {
    let root = reader.root.clone();
    *reader = Reader::new(
        &root,
        Config {
            flags: NAME_CHANGES,
            buffer_bytes: 4096,
        },
    )?;
    pending.clear();
    match kind {
        "overflow" => {
            // No consumer rearms this reader while the kernel buffer overflows.
            for index in 0..2048 {
                fs::write(root.join(format!("overflow-{index:04}")), b"complete")?;
            }
            reader.wait_completion()?;
            reader.drain(pending)?;
        }
        "completions" => {
            reader.replenish = 64;
            fs::write(root.join("completion-start"), b"complete")?;
            reader.wait_completion()?;
            reader.drain(pending)?;
            reader.replenish = 0;
        }
        "changes" => {
            // Small batches avoid the kernel overflow, isolating the 100k cap.
            for index in 0..100_001 {
                fs::write(root.join(format!("change-{index:06}")), b"complete")?;
                reader.wait_completion()?;
                reader.drain(pending)?;
            }
        }
        _ => return Err(io::Error::other("unknown notification fixture")),
    }
    if reader.rescan_reason != Some(kind) || !pending.iter().any(|c| matches!(c, Change::Rescan)) {
        return Err(io::Error::other(format!(
            "expected {kind}, got {:?}",
            reader.rescan_reason
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Watch;
    use std::{
        path::PathBuf,
        time::{Duration, SystemTime},
    };
    struct Root(PathBuf);
    impl Root {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("notify-{}-{nonce}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn watch(&self) -> Watch {
            Watch::new(
                &self.0,
                Config {
                    flags: NAME_CHANGES,
                    buffer_bytes: 4096,
                },
            )
            .unwrap()
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    // test-category: security
    #[test]
    fn real_overflow_and_caps_rescan() {
        for kind in ["overflow", "completions", "changes"] {
            let root = Root::new();
            let watch = root.watch();
            watch.exercise(kind).unwrap();
            let events = watch.drain(Duration::from_secs(2)).unwrap();
            assert!(events.iter().any(|e| matches!(e, Change::Rescan)), "{kind}");
        }
    }
    // test-category: security
    #[test]
    fn deleted_root_loses_watcher() {
        let root = Root::new();
        let watch = root.watch();
        fs::remove_dir(&root.0).unwrap();
        let result = watch.drain(Duration::from_secs(2));
        assert!(result.is_err() || result.unwrap().iter().any(|e| matches!(e, Change::Lost)));
    }
}
