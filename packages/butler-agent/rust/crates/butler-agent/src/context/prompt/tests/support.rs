use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::btcc::ContextSection;

pub(super) fn ids(sections: &[ContextSection]) -> Vec<&str> {
    sections.iter().map(|value| value.id.as_str()).collect()
}

pub(super) fn temp(name: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    std::env::temp_dir().join(format!(
        "butler-c3-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}
