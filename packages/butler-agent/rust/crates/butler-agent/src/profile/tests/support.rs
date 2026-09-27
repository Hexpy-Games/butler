use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use super::super::*;
use crate::configuration::ConfigurationWrites;
use crate::coordination::{
    CognitionCoordinationHost, CognitionProcessStatus, CognitionWriteCoordinator,
    CoordinationResult,
};
use crate::models::ProviderPromptPort;

pub(super) struct Root(pub(super) PathBuf);
impl Root {
    pub(super) fn new(label: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("butler-profile-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(super) struct Host {
    sequence: AtomicUsize,
}
impl Host {
    pub(super) fn new() -> Self {
        Self {
            sequence: AtomicUsize::new(0),
        }
    }
}
impl ProfileHostFacts for Host {
    fn process_id(&self) -> u32 {
        1234
    }
    fn process_status(&self, pid: f64) -> CognitionProcessStatus {
        if pid == 1234.0 {
            CognitionProcessStatus::Alive
        } else {
            CognitionProcessStatus::DefinitelyDead
        }
    }
    fn new_uuid(&self) -> String {
        format!("id-{}", self.sequence.fetch_add(1, Ordering::SeqCst))
    }
    fn now_epoch_millis(&self) -> i64 {
        1_700_000_000_000
            + i64::try_from(self.sequence.fetch_add(1, Ordering::SeqCst)).unwrap_or(i64::MAX)
    }
    fn now_iso(&self) -> String {
        "2023-11-14T22:13:20.000Z".into()
    }
}
impl CognitionCoordinationHost for Host {
    fn process_id(&self) -> u32 {
        1234
    }
    fn hostname(&self) -> CoordinationResult<String> {
        Ok("profile-test".into())
    }
    fn process_status(&self, pid: u64) -> CognitionProcessStatus {
        if pid == 1234 {
            CognitionProcessStatus::Alive
        } else {
            CognitionProcessStatus::DefinitelyDead
        }
    }
    fn new_uuid(&self) -> String {
        ProfileHostFacts::new_uuid(self)
    }
    fn now_epoch_millis(&self) -> i64 {
        ProfileHostFacts::now_epoch_millis(self)
    }
    fn now_iso(&self) -> String {
        ProfileHostFacts::now_iso(self)
    }
}

struct Sources {
    messages: Arc<Mutex<HashMap<String, CanonicalProfileMessage>>>,
    closed: Arc<AtomicUsize>,
}

struct Reader {
    messages: Arc<Mutex<HashMap<String, CanonicalProfileMessage>>>,
    closed: Arc<AtomicUsize>,
}
impl CanonicalProfileSourceFactory for Sources {
    fn open(&self) -> ProfileResult<Box<dyn CanonicalProfileSourceReader>> {
        Ok(Box::new(Reader {
            messages: self.messages.clone(),
            closed: self.closed.clone(),
        }))
    }
}
impl CanonicalProfileSourceReader for Reader {
    fn read_cognition_messages(
        &mut self,
        scan: CanonicalProfileScan,
    ) -> ProfileResult<Vec<CanonicalProfileMessage>> {
        let mut messages = self
            .messages
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        messages.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(messages
            .into_iter()
            .filter(|message| message.role == "user")
            .filter(|message| {
                scan.since
                    .as_ref()
                    .is_none_or(|since| message.created_at >= *since)
            })
            .skip(crate::json::saturating_usize(scan.offset.max(0.0).floor()))
            .take(crate::json::saturating_usize(scan.limit.max(0.0).floor()))
            .collect())
    }
    fn read_message(&mut self, id: &str) -> ProfileResult<Option<CanonicalProfileMessage>> {
        Ok(self.messages.lock().unwrap().get(id).cloned())
    }
    fn close(self: Box<Self>) -> ProfileResult<()> {
        self.closed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

pub(super) fn service(
    root: &Root,
    messages: HashMap<String, CanonicalProfileMessage>,
) -> (Arc<ProfileService>, Arc<AtomicUsize>) {
    let (service, closed, _) =
        service_with_provider(root, messages, Arc::new(super::provider::Provider));
    (service, closed)
}

pub(super) fn service_with_provider(
    root: &Root,
    messages: HashMap<String, CanonicalProfileMessage>,
    provider: Arc<dyn ProviderPromptPort>,
) -> ProfileFixture {
    let messages = Arc::new(Mutex::new(messages));
    let (service, closed) = service_with_parts(root, messages.clone(), provider);
    (service, closed, messages)
}

pub(super) type ProfileMessageMap = Arc<Mutex<HashMap<String, CanonicalProfileMessage>>>;
pub(super) type ProfileFixture = (Arc<ProfileService>, Arc<AtomicUsize>, ProfileMessageMap);

pub(super) fn service_with_parts(
    root: &Root,
    messages: ProfileMessageMap,
    provider: Arc<dyn ProviderPromptPort>,
) -> (Arc<ProfileService>, Arc<AtomicUsize>) {
    let host = Arc::new(Host::new());
    let coordinator = Arc::new(CognitionWriteCoordinator::new(host.clone()).unwrap());
    let closed = Arc::new(AtomicUsize::new(0));
    let service = Arc::new(ProfileService::new(
        root.0.clone(),
        root.0.join("cognition"),
        Arc::new(PersonaPresets::new(root.0.clone())),
        Arc::new(ConfigurationWrites::new()),
        coordinator,
        host,
        Arc::new(Sources {
            messages,
            closed: closed.clone(),
        }),
        provider,
    ));
    (service, closed)
}
