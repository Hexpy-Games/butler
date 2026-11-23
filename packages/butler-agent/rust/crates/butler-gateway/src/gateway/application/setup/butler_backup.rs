#[derive(serde::Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ButlerBackupRequest {
    /// Local state only; never calls the Butler service.
    #[serde(skip)]
    Status,
    /// Status after fetching usage, quota and snapshots from the service.
    Refresh,
    CreateKey,
    Start,
    Cancel,
    BackUpNow,
    NewKey,
    TurnOff,
    Restore {
        recovery_key: String,
    },
    Restart,
}
