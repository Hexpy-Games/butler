//! DATA-relative process plumbing shared by lifecycle owners and reset retention.
pub(crate) const INSTANCE_LOCK: &str = "state/butler-agent-native-service.lock";
pub(crate) const ADMISSION_LOCK: &str = "state/butler-agent-native-service-start.lock";
pub(crate) const INSTANCE_RECORD: &str = "state/butler-agent-native-service.json";
/// Taken before [`INSTANCE_LOCK`] by every holder; see `instance::observe`.
pub(crate) const RECORD_LOCK: &str = "state/butler-agent-native-service-record.lock";
pub(crate) const STOP_INTENT: &str = "state/agent-stop-intent.json";
pub(crate) const CLI_SUPERVISOR_LOCK: &str = "state/agent-cli-supervisor.lock";
