//! Minimal read facts for the same indexed conversation permission query.
pub(crate) struct PermissionSource<'a> {
    pub owner: &'a str,
    pub workspace: &'a str,
    pub capability: &'a str,
    pub target: &'a str,
    pub input_json: &'a str,
}
pub(crate) struct PermissionTarget {
    pub grant_ref: String,
    pub capability: String,
    pub target: String,
    pub cwd: Option<String>,
}
