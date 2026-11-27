use parking_lot::Mutex;
use std::{
    collections::HashMap,
    sync::LazyLock,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

type Entries = HashMap<String, (Zeroizing<String>, Instant)>;

static STASH: LazyLock<Mutex<Entries>> = LazyLock::new(Mutex::default);
const TTL: Duration = Duration::from_mins(5);

pub(in crate::gateway) fn insert(request_ref: String, password: Zeroizing<String>) {
    let mut stash = STASH.lock();
    let now = Instant::now();
    stash.retain(|_, (_, expires)| *expires > now);
    stash.insert(request_ref, (password, now + TTL));
}

pub(super) fn take(request_ref: &str) -> Option<Zeroizing<String>> {
    let mut stash = STASH.lock();
    let now = Instant::now();
    stash.retain(|_, (_, expires)| *expires > now);
    stash.remove(request_ref).map(|(password, _)| password)
}
