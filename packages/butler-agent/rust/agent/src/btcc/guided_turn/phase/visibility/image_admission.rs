use crate::btcc::AccessMode;

use super::super::policy::GuidedExecutionPolicy;
use crate::tool_protocol::ToolName;

pub(in crate::btcc::guided_turn::phase) fn turn_admits_zai_image_tool(
    policy: &GuidedExecutionPolicy,
) -> bool {
    policy.access_mode == AccessMode::FullAccess
        && policy
            .required_tools
            .iter()
            .any(|name| name == ToolName::AnalyzeAttachedImage)
}
