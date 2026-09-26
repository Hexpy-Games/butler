use crate::btcc::AccessMode;

use super::super::policy::GuidedExecutionPolicy;

pub(in crate::btcc::guided_turn::phase) fn turn_admits_zai_image_tool(
    policy: &GuidedExecutionPolicy,
) -> bool {
    policy.access_mode == AccessMode::FullAccess
        && policy
            .required_tools
            .iter()
            .any(|name| name == "analyze_attached_image")
}
