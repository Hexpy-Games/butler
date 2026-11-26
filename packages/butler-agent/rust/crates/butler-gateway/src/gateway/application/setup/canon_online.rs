#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum CanonOnlineRequest {
    #[serde(skip)]
    Status,
    Spaces,
    Link {
        project_id: String,
        name: String,
    },
    Join {
        project_id: String,
        token: String,
    },
    Members {
        project_id: String,
    },
    Invite {
        project_id: String,
        email: String,
        role: String,
    },
    RevokeInvite {
        project_id: String,
        invite_id: String,
    },
    SetRole {
        project_id: String,
        account_id: String,
        role: String,
    },
    RemoveMember {
        project_id: String,
        account_id: String,
    },
    Leave {
        project_id: String,
    },
    Unlink {
        project_id: String,
    },
}
