//! Sandbox credential policy is owned by the secure filesystem facade.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) use crate::secure_fs::credential_roots as roots;
pub use crate::secure_fs::secret_name;
#[cfg(target_os = "macos")]
pub(super) use crate::secure_fs::{secret_pattern, ssh_agent_readable};
