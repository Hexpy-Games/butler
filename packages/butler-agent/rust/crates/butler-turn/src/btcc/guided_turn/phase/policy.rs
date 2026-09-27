use serde_json::{Map, Value};

use crate::btcc::{AccessMode, TurnRecord};

use super::super::work::GuidedPreparationError;

/// The role a guided turn runs as; other stored names are kept verbatim.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PolicyRole {
    Butler,
    Steward,
    Worker,
    Other(String),
}

impl PolicyRole {
    fn parse(value: String) -> Self {
        match value.as_ref() {
            "butler" => Self::Butler,
            "steward" => Self::Steward,
            "worker" => Self::Worker,
            _ => Self::Other(value),
        }
    }

    /// The role name.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Butler => "butler",
            Self::Steward => "steward",
            Self::Worker => "worker",
            Self::Other(value) => value,
        }
    }
}

impl std::fmt::Display for PolicyRole {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Debug)]
pub struct GuidedExecutionPolicy {
    pub role: PolicyRole,
    pub access_mode: AccessMode,
    pub tracking_mode: String,
    pub required_profiles: Vec<String>,
    pub required_tools: Vec<String>,
    pub workspace_path: String,
    pub project_id: Option<String>,
    pub(crate) subsession: Option<SubsessionPolicy>,
}

/// The delegated-subsession part of an execution policy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SubsessionPolicy {
    /// `executionMode`, when it is a string.
    pub(crate) execution_mode: Option<String>,
    /// `mutationScope`, when it is an array of strings.
    pub(crate) mutation_scope: Option<Vec<String>>,
}

impl SubsessionPolicy {
    /// Reads the policy's `subsession` entry (parse boundary: the context
    /// document is untyped JSON).
    // Passthrough: context document assembled by the context assembler, persisted verbatim; typed reads use ButlerContext.
    fn read(value: &Value) -> Self {
        let mutation_scope = value
            .get("mutationScope")
            .and_then(Value::as_array)
            .and_then(|values| {
                values
                    .iter()
                    .map(|value| value.as_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()
            });
        Self {
            execution_mode: value
                .get("executionMode")
                .and_then(Value::as_str)
                .map(str::to_owned),
            mutation_scope,
        }
    }
}

impl GuidedExecutionPolicy {
    /// Reads the turn's execution policy, or the butler default when the
    /// context carries none, never widening the access mode the model
    /// selection admitted. The context document is untyped JSON (passthrough
    /// of the context assembler), so this is its parse boundary.
    pub(crate) fn from_turn(
        turn: &TurnRecord,
        default_workspace: &str,
    ) -> Result<Self, GuidedPreparationError> {
        let admitted = access(
            turn.model_selection
                .controls
                .get("accessMode")
                .and_then(Value::as_str)
                .unwrap_or("read_only"),
        );
        let context = turn
            .context
            .as_object()
            .ok_or(GuidedPreparationError::Contract("invalid_butler_context"))?;
        let project_ref = context
            .get("projectRef")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let Some(mut raw) = context
            .get("executionPolicy")
            .filter(|value| !value.is_null())
            .cloned()
        else {
            return Ok(default_policy(
                context,
                admitted,
                project_ref,
                default_workspace,
            ));
        };
        let policy = raw
            .as_object_mut()
            .ok_or(GuidedPreparationError::Contract("invalid_execution_policy"))?;
        if let Some(project) = project_ref
            && !policy.get("projectId").is_some_and(truthy)
        {
            policy.insert("projectId".into(), Value::String(project.into()));
        }
        let access_mode = policy
            .get("accessMode")
            .and_then(Value::as_str)
            .map(access)
            .unwrap_or(AccessMode::ReadOnly)
            .narrower(admitted);
        policy.insert(
            "accessMode".into(),
            Value::String(access_mode.as_str().into()),
        );
        Ok(Self {
            role: PolicyRole::parse(string(policy, "role")?),
            access_mode,
            tracking_mode: string(policy, "trackingMode")?,
            required_profiles: strings(policy, "requiredNativeToolProfiles"),
            required_tools: strings(policy, "requiredNativeTools"),
            workspace_path: string(policy, "workspacePath")?,
            project_id: policy
                .get("projectId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            subsession: policy
                .get("subsession")
                .filter(|value| truthy(value))
                .map(SubsessionPolicy::read),
        })
    }
}

/// The butler policy of a turn without one: ledger tracking with a project,
/// local tracking otherwise, in the baseline workspace scope.
/// (The context document is untyped JSON; see [`GuidedExecutionPolicy::from_turn`].)
fn default_policy(
    // Passthrough: context document assembled by the context assembler, persisted verbatim; typed reads use ButlerContext.
    context: &Map<String, Value>,
    admitted: AccessMode,
    project_ref: Option<&str>,
    default_workspace: &str,
) -> GuidedExecutionPolicy {
    let workspace = context
        .get("baselineObservationScopeRefs")
        .and_then(Value::as_array)
        .and_then(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .find_map(|value| value.strip_prefix("workspace:"))
        })
        .unwrap_or(default_workspace);
    let tracking = if project_ref.is_some() {
        "ledger"
    } else {
        "local"
    };
    GuidedExecutionPolicy {
        role: PolicyRole::Butler,
        access_mode: admitted,
        tracking_mode: tracking.into(),
        required_profiles: Vec::new(),
        required_tools: Vec::new(),
        workspace_path: workspace.into(),
        project_id: project_ref.map(str::to_owned),
        subsession: None,
    }
}

impl GuidedExecutionPolicy {
    pub(crate) fn has_project_id(&self) -> bool {
        self.project_id
            .as_deref()
            .is_some_and(|value| !value.is_empty())
    }
}

impl AccessMode {
    pub(super) fn as_str(&self) -> &'static str {
        match self {
            Self::FullAccess => "full_access",
            Self::AskFirst => "ask_first",
            Self::ReadOnly => "read_only",
        }
    }
    fn narrower(self, admitted: Self) -> Self {
        if rank(&self) <= rank(&admitted) {
            self
        } else {
            admitted
        }
    }
}
fn rank(mode: &AccessMode) -> u8 {
    match mode {
        AccessMode::ReadOnly => 0,
        AccessMode::AskFirst => 1,
        AccessMode::FullAccess => 2,
    }
}
fn access(value: &str) -> AccessMode {
    match value {
        "full_access" => AccessMode::FullAccess,
        "ask_first" => AccessMode::AskFirst,
        _ => AccessMode::ReadOnly,
    }
}
fn string(map: &Map<String, Value>, key: &str) -> Result<String, GuidedPreparationError> {
    map.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(GuidedPreparationError::Contract("invalid_execution_policy"))
}
fn strings(map: &Map<String, Value>, key: &str) -> Vec<String> {
    map.get(key)
        .and_then(Value::as_array)
        .map(|array| {
            array
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
// Passthrough: context document assembled by the context assembler, persisted verbatim; typed reads use ButlerContext.
fn truthy(value: &Value) -> bool {
    !matches!(value, Value::Null | Value::Bool(false))
        && !matches!(value, Value::String(text) if text.is_empty())
        && !matches!(value, Value::Number(number) if number.as_f64() == Some(0.0))
}
