use std::fs;

use super::*;
use crate::profile::contracts::{
    CanonicalProfileMessage, CanonicalProfileScan, ProfileError, ProfileResult,
};

struct Root(std::path::PathBuf);
impl Root {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "butler-profile-reader-close-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Factory;
struct Reader;
struct EmptyFactory;
struct EmptyReader;

impl CanonicalProfileSourceFactory for Factory {
    fn open(&self) -> ProfileResult<Box<dyn CanonicalProfileSourceReader>> {
        Ok(Box::new(Reader))
    }
}

impl CanonicalProfileSourceReader for Reader {
    fn read_cognition_messages(
        &mut self,
        _scan: CanonicalProfileScan,
    ) -> ProfileResult<Vec<CanonicalProfileMessage>> {
        Err(ProfileError::new("read_failed", "read failed"))
    }

    fn read_message(&mut self, _id: &str) -> ProfileResult<Option<CanonicalProfileMessage>> {
        Err(ProfileError::new("read_failed", "read failed"))
    }

    fn close(self: Box<Self>) -> ProfileResult<()> {
        Err(ProfileError::new("close_failed", "close failed"))
    }
}

impl CanonicalProfileSourceFactory for EmptyFactory {
    fn open(&self) -> ProfileResult<Box<dyn CanonicalProfileSourceReader>> {
        Ok(Box::new(EmptyReader))
    }
}

impl CanonicalProfileSourceReader for EmptyReader {
    fn read_cognition_messages(
        &mut self,
        _scan: CanonicalProfileScan,
    ) -> ProfileResult<Vec<CanonicalProfileMessage>> {
        Ok(Vec::new())
    }

    fn read_message(&mut self, _id: &str) -> ProfileResult<Option<CanonicalProfileMessage>> {
        Ok(None)
    }

    fn close(self: Box<Self>) -> ProfileResult<()> {
        Ok(())
    }
}

#[test]
fn source_finally_close_error_replaces_read_error() {
    let root = Root::new();
    let Err(error) = read(&root.0, &Factory, &Default::default()) else {
        panic!("read unexpectedly succeeded");
    };
    assert_eq!(error.code, "close_failed");
}

#[test]
fn missing_precoverage_schema_falls_back_to_empty_retained_set() {
    let root = Root::new();
    let path = crate::profile::storage::database_path(&root.0);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    rusqlite::Connection::open(path).unwrap();

    let source = read(&root.0, &EmptyFactory, &Default::default()).unwrap();
    assert!(source.windows.is_empty());
    assert_eq!(source.current_obligation_count, 0);
    assert!(!source.discovery_incomplete);
}
