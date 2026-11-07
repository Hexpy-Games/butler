//! Wire types for the P2 wave-2 `canon_proposal` unit (mirror TS, `/// TS: path:line`).
use serde::{Deserialize, Deserializer};

/// A text that may be `null`; the field's outer `Option` says whether the key was present.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CanonProposalNullable(Option<String>);

impl CanonProposalNullable {
    pub(crate) fn as_deref(&self) -> Option<&str> {
        self.0.as_deref()
    }

    pub(crate) fn unwrap_or_else(self, default: impl FnOnce() -> String) -> String {
        self.0.unwrap_or_else(default)
    }
}

/// A key that may be absent, `null` or a value; absent is `None`, `null` is `Some` of a null.
fn canon_proposal_present<'de, D>(d: D) -> Result<Option<CanonProposalNullable>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(d).map(|value| Some(CanonProposalNullable(value)))
}

/// TS: packages/butler-app/client/shared/canon-proposal-contracts.ts:6 CanonProposal (state)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CanonProposalState {
    Open,
    Applied,
    Cancelled,
    Superseded,
    Stale,
}

/// TS: packages/butler-app/client/shared/canon-proposal-contracts.ts:8 CanonProposal (project)
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub(crate) enum CanonProposalProject {
    Existing {
        #[serde(default)]
        id: Option<String>,
        name: String,
    },
    New {
        new_name: String,
    },
}

/// TS: packages/butler-app/client/shared/canon-proposal-contracts.ts:9 CanonProposal (plan)
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonProposalPlan {
    pub(crate) title: String,
}

/// TS: packages/butler-app/client/shared/canon-proposal-contracts.ts:10 CanonProposal (changes)
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonProposalChange {
    pub(crate) op: String,
    #[serde(default)]
    pub(crate) id: Option<String>,
    #[serde(default)]
    pub(crate) title: Option<String>,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) body: Option<String>,
    #[serde(default, deserialize_with = "canon_proposal_present")]
    pub(crate) due_on: Option<CanonProposalNullable>,
    #[serde(default)]
    pub(crate) status: Option<String>,
    #[serde(default, deserialize_with = "canon_proposal_present")]
    pub(crate) assignee: Option<CanonProposalNullable>,
    #[serde(default)]
    pub(crate) order_titles: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) current_plan_title: Option<String>,
    #[serde(default)]
    pub(crate) destination_plan_title: Option<String>,
}

/// TS: packages/butler-app/client/shared/canon-proposal-contracts.ts:11 CanonProposal (epics tags)
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonProposalTag {
    #[serde(default)]
    pub(crate) id: Option<String>,
    pub(crate) name: String,
    pub(crate) color: String,
}

/// TS: packages/butler-app/client/shared/canon-proposal-contracts.ts:11 CanonProposal (epics)
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonProposalEpic {
    pub(crate) title: String,
    pub(crate) description: String,
    #[serde(default)]
    pub(crate) tags: Vec<CanonProposalTag>,
}

/// TS: packages/butler-app/client/shared/canon-proposal-contracts.ts:4 CanonProposal
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonProposalView {
    pub(crate) proposal_id: String,
    pub(crate) state: CanonProposalState,
    pub(crate) target_label: String,
    pub(crate) project: CanonProposalProject,
    #[serde(default)]
    pub(crate) plan: Option<CanonProposalPlan>,
    #[serde(default)]
    pub(crate) changes: Vec<CanonProposalChange>,
    #[serde(default)]
    pub(crate) epics: Vec<CanonProposalEpic>,
    #[serde(default)]
    pub(crate) resolved_by: Option<String>,
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:180 ProjectSummary (the
/// fields the proposal's project choice reads).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonProposalProjectOption {
    pub(crate) id: String,
    pub(crate) display_name: String,
}

/// TS: packages/butler-app/client/shared/dashboard-space-contracts.ts:54 NavigationView (projects)
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonProposalNavigation {
    #[serde(default)]
    pub(crate) projects: Vec<CanonProposalProjectOption>,
}

/// TS: packages/butler-app/client/ui/src/app/canonProposals.ts:11 resolveCanonProposal (result)
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonProposalResolved {
    pub(crate) ok: bool,
    #[serde(default)]
    pub(crate) error: Option<CanonProposalResolveError>,
}

/// TS: packages/butler-app/client/ui/src/app/canonProposals.ts:11 resolveCanonProposal (error)
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonProposalResolveError {
    pub(crate) code: String,
}
