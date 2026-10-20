use super::super::*;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
struct Clock(AtomicU64);
impl AppIdentityClock for Clock {
    fn new_uuid(&self) -> String {
        format!(
            "00000000-0000-4000-8000-{:012x}",
            self.0.fetch_add(1, Ordering::Relaxed)
        )
    }
    fn now_iso(&self) -> String {
        format!("2026-10-20T00:00:00.{:03}Z", self.0.load(Ordering::Relaxed))
    }
    fn iso_after_millis(&self, _: u64) -> String {
        self.now_iso()
    }
}

fn snapshot(file: MaterializedResponderFile) -> AppMessageFileSnapshot {
    AppMessageFileSnapshot {
        id: file.id,
        owner_session_id: Some("owner".into()),
        message_id: None,
        kind: file.kind,
        mime_type: file.mime_type,
        safe_name: file.safe_name,
        size_bytes: file.size_bytes,
        sha256: file.sha256,
        storage_name: file.storage_name,
        created_at: file.created_at,
        title: file.title,
        source_label: file.source_label,
        deliverable: file.deliverable,
    }
}

async fn upload(
    owner: &AppMessageFiles,
    name: &str,
    bytes: &'static [u8],
) -> AppMessageFileSnapshot {
    snapshot(
        owner
            .write_upload(AppFileWrite {
                name: name.into(),
                mime_type: Some("image/jpeg".into()),
                bytes: Bytes::from_static(bytes),
            })
            .await
            .unwrap(),
    )
}

// test-category: race
#[tokio::test]
async fn duplicate_uploads_keep_metadata_and_mutable_slots_cannot_change_shared_bytes() {
    let root = std::env::temp_dir().join(format!("upload-cache-{}", uuid::Uuid::new_v4()));
    let owner = AppMessageFiles::new(&root, Arc::new(Clock::default()));
    let first = upload(&owner, "browser-step-first.jpg", b"first picture").await;
    let second = upload(&owner, "browser-step-second.jpg", b"first picture").await;
    let third = upload(&owner, "third.jpg", b"first picture").await;
    assert_ne!(first.id, second.id);
    assert_ne!(second.id, third.id);
    assert_ne!(first.created_at, second.created_at);
    assert_ne!(first.safe_name, second.safe_name);
    assert_eq!(first.sha256, second.sha256);
    assert_eq!(second.storage_name, second.id);
    assert_eq!(third.storage_name, third.id);
    assert_eq!(second.size_bytes, 13);
    assert_eq!(second.mime_type, "image/jpeg");
    let replaced = snapshot(
        owner
            .replace_browser_still(
                first,
                Bytes::from_static(b"second picture"),
                "browser-step-first.jpg".into(),
            )
            .await
            .unwrap(),
    );
    let replaced_alias = snapshot(
        owner
            .replace_browser_still(
                second,
                Bytes::from_static(b"third picture"),
                "browser-step-second.jpg".into(),
            )
            .await
            .unwrap(),
    );
    assert_eq!(
        owner.read_original(replaced).await.unwrap(),
        b"second picture"[..]
    );
    assert_eq!(
        owner.read_original(replaced_alias).await.unwrap(),
        b"third picture"[..]
    );
    assert_eq!(
        owner.read_original(third.clone()).await.unwrap(),
        b"first picture"[..]
    );
    let directory = root.join(butler_platform::data_paths::MESSAGE_FILES);
    let candidate = upload(&owner, "candidate.jpg", b"first picture").await;
    std::fs::write(directory.join(&candidate.storage_name), b"FIRST PICTURE").unwrap();
    let repaired = upload(&owner, "fresh.jpg", b"first picture").await;
    assert_eq!(
        owner.read_original(repaired).await.unwrap(),
        b"first picture"[..]
    );
    let mutable = upload(&owner, "browser-step-lone.jpg", b"lone picture").await;
    let changed = snapshot(
        owner
            .replace_browser_still(
                mutable,
                Bytes::from_static(b"changed picture"),
                "browser-step-lone.jpg".into(),
            )
            .await
            .unwrap(),
    );
    let original = upload(&owner, "original.jpg", b"lone picture").await;
    assert_eq!(
        owner.read_original(original).await.unwrap(),
        b"lone picture"[..]
    );
    assert_eq!(
        owner.read_original(changed).await.unwrap(),
        b"changed picture"[..]
    );
    owner.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

// test-category: pure-logic
#[test]
fn lookup_inventory_stays_bounded_and_invalidates_only_matching_sources() {
    let mut cache = super::Cache::default();
    for index in 0..300 {
        cache.remember(index.to_string(), format!("file-{index}"), 256 * 1024);
    }
    assert!(cache.bytes <= super::CACHE_BYTES);
    assert!(cache.items.len() <= super::CACHE_ITEMS);
    assert!(!cache.items.contains_key("0"));
    cache.replacing("299", "file-299");
    assert!(!cache.items.contains_key("299"));
    cache.replacing("298", "another-file");
    assert!(cache.items.contains_key("298"));
    cache.replacing("298", "file-298");
    assert!(!cache.items.contains_key("298"));
}
