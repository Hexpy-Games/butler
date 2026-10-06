//! Minimal read facts for the same indexed conversation permission query.
pub(crate) struct PermissionSource {
    pub owner: String,
    pub workspace: String,
    pub capability: String,
    pub target: String,
    pub input_json: String,
}
pub(crate) struct PermissionTarget {
    pub grant_ref: String,
    pub capability: String,
    pub target: String,
    pub cwd: Option<String>,
}
