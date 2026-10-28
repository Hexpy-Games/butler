//! Share immutable fixture files while concurrent scenarios keep private state.
use super::{HarnessError, Sandbox, harness_error};
use std::sync::{Arc, Mutex, Weak};

static INSTALLATION: Mutex<Weak<Sandbox>> = Mutex::new(Weak::new());

impl Sandbox {
    /// Copy and sync the executable once for overlapping scenarios. The last
    /// scenario releases the installation; the weak cache keeps nothing idle.
    /// Use `new` instead for scenarios that mutate their installation.
    pub fn shared_installation(scenario: &str) -> Result<Self, HarnessError> {
        let installation = {
            let mut cached = INSTALLATION
                .lock()
                .map_err(|_| harness_error("shared installation lock poisoned"))?;
            if let Some(installation) = cached.upgrade() {
                installation
            } else {
                let mut sandbox = Self::new("shared-installation")?;
                sandbox.mark_success();
                let installation = Arc::new(sandbox);
                *cached = Arc::downgrade(&installation);
                installation
            }
        };
        let mut sandbox = Self::with_installation(scenario, &installation)?;
        sandbox.installation = Some(installation);
        Ok(sandbox)
    }
}
