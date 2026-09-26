use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum AppSpaceCommand {
    Create {
        expected_revision: i64,
        title: String,
        parent_key: Option<String>,
    },
    Rename {
        expected_revision: i64,
        group_id: String,
        title: String,
    },
    Dissolve {
        expected_revision: i64,
        group_id: String,
    },
    Move {
        expected_revision: i64,
        source_key: String,
        target_key: Option<String>,
        position: AppSpacePosition,
    },
    Group {
        expected_revision: i64,
        source_key: String,
        target_key: String,
        title: Option<String>,
    },
    Undo {
        expected_revision: i64,
        undo_token: String,
    },
    Pin {
        expected_revision: i64,
        node_key: String,
        pinned: bool,
    },
}

impl AppSpaceCommand {
    pub(super) fn expected_revision(&self) -> i64 {
        match self {
            Self::Create {
                expected_revision, ..
            }
            | Self::Rename {
                expected_revision, ..
            }
            | Self::Dissolve {
                expected_revision, ..
            }
            | Self::Move {
                expected_revision, ..
            }
            | Self::Group {
                expected_revision, ..
            }
            | Self::Undo {
                expected_revision, ..
            }
            | Self::Pin {
                expected_revision, ..
            } => *expected_revision,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AppSpacePosition {
    Before,
    After,
    Inside,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum AppSpaceOrigin {
    #[default]
    Manual,
    Smart,
}

impl AppSpaceOrigin {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Smart => "smart",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSpaceNode {
    pub key: String,
    pub kind: String,
    pub entity_id: String,
    pub parent_key: Option<String>,
    pub position: i64,
    pub revision: i64,
    pub manual_placement: bool,
    pub scope_project_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSpaceGroup {
    pub id: String,
    pub title: String,
    pub scope_project_id: Option<String>,
    pub origin: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSpaceSmartNotice {
    pub title: String,
    pub undo_token: String,
    pub revision: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSpaceView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub smart_notice: Option<AppSpaceSmartNotice>,
    pub revision: i64,
    pub nodes: Vec<AppSpaceNode>,
    pub groups: Vec<AppSpaceGroup>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSpaceMutationResult {
    pub space: AppSpaceView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub undo_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
}
