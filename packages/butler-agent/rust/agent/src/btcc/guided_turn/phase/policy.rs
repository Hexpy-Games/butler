use serde_json::{Map, Value};

use crate::btcc::{AccessMode, TurnRecord};

use super::super::work::GuidedPreparationError;

#[derive(Clone, Debug)]
pub(crate) struct GuidedExecutionPolicy {
    pub(crate) role: String,
    pub(crate) access_mode: AccessMode,
    pub(crate) tracking_mode: String,
    pub(crate) required_profiles: Vec<String>,
    pub(crate) required_tools: Vec<String>,
    pub(crate) workspace_path: String,
    pub(crate) project_id: Option<String>,
    pub(crate) subsession: Option<Value>,
    #[cfg(test)]
    pub(crate) raw: Value,
}

impl GuidedExecutionPolicy {
    pub(crate) fn from_turn(
        turn: &TurnRecord,
        default_workspace: &str,
    ) -> Result<Self, GuidedPreparationError> {
        let admitted = turn
            .model_selection
            .get("controls")
            .and_then(|value| value.get("accessMode"))
            .and_then(Value::as_str)
            .unwrap_or("read_only");
        let admitted = access(admitted);
        let context = turn
            .context
            .as_object()
            .ok_or(GuidedPreparationError::Contract("invalid_butler_context"))?;
        let project_ref = context
            .get("projectRef")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let mut raw = context
            .get("executionPolicy")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| {
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
                let mut result = Map::new();
                result.insert("role".into(), Value::String("butler".into()));
                result.insert("accessMode".into(), Value::String(admitted.as_str().into()));
                result.insert(
                    "trackingMode".into(),
                    Value::String(
                        if project_ref.is_some() {
                            "ledger"
                        } else {
                            "local"
                        }
                        .into(),
                    ),
                );
                result.insert("requiredNativeToolProfiles".into(), Value::Array(vec![]));
                result.insert("requiredNativeTools".into(), Value::Array(vec![]));
                result.insert("workspacePath".into(), Value::String(workspace.into()));
                if let Some(project) = project_ref {
                    result.insert("projectId".into(), Value::String(project.into()));
                }
                Value::Object(result)
            });
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
            role: string(policy, "role")?,
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
                .cloned(),
            #[cfg(test)]
            raw,
        })
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
fn truthy(value: &Value) -> bool {
    !matches!(value, Value::Null | Value::Bool(false))
        && !matches!(value, Value::String(text) if text.is_empty())
        && !matches!(value, Value::Number(number) if number.as_f64() == Some(0.0))
}
