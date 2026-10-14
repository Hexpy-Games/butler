//! Deterministic App clock for stub E2E boundary scenarios in either profile.
use crate::host::SystemIdentity;
use butler_gateway::gateway::AppIdentityClock;
use parking_lot::RwLock;
use std::sync::{Arc, OnceLock};

pub(in crate::host) fn clock() -> Arc<dyn AppIdentityClock> {
    if std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("stub")
        && let Ok(now) = std::env::var("BUTLER_E2E_APP_NOW")
        && chrono::DateTime::parse_from_rfc3339(&now).is_ok()
    {
        static CLOCK: OnceLock<Arc<FixedClock>> = OnceLock::new();
        return CLOCK
            .get_or_init(|| {
                let clock = Arc::new(FixedClock(RwLock::new(now)));
                #[cfg(feature = "e2e-fixtures")]
                if let Ok(address) = std::env::var("BUTLER_E2E_APP_CLOCK_ADDRESS") {
                    start_control(clock.clone(), &address);
                }
                clock
            })
            .clone();
    }
    Arc::new(SystemIdentity)
}

// A loopback-only test clock control. Updating it never notifies job schedulers.
#[cfg(feature = "e2e-fixtures")]
fn start_control(clock: Arc<FixedClock>, address: &str) {
    use std::io::{BufRead, BufReader, Write};
    let Ok(address) = address.parse::<std::net::SocketAddr>() else {
        return;
    };
    if !address.ip().is_loopback() {
        return;
    }
    let Ok(listener) = std::net::TcpListener::bind(address) else {
        return;
    };
    let _ = std::thread::Builder::new()
        .name("test-wall-clock".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(1)));
                let mut reader = BufReader::new(stream);
                let mut value = String::new();
                if reader.read_line(&mut value).is_ok()
                    && let Ok(time) = chrono::DateTime::parse_from_rfc3339(value.trim())
                {
                    *clock.0.write() = time
                        .with_timezone(&chrono::Utc)
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                    let _ = reader.get_mut().write_all(b"ok\n");
                }
            }
        });
}

struct FixedClock(RwLock<String>);
impl AppIdentityClock for FixedClock {
    fn new_uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn now_iso(&self) -> String {
        self.0.read().clone()
    }
    fn iso_after_millis(&self, millis: u64) -> String {
        let now = self.now_iso();
        chrono::DateTime::parse_from_rfc3339(&now)
            .ok()
            .and_then(|now| {
                now.checked_add_signed(chrono::Duration::milliseconds(i64::try_from(millis).ok()?))
            })
            .map(|now| {
                now.with_timezone(&chrono::Utc)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            })
            .unwrap_or(now)
    }
}
