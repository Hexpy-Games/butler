//! Authority and bounded instruction validation shared by Task directions.
use super::*;
impl SubsessionService {
    pub(super) async fn direction_instruction(
        &self,
        request: &SubsessionDirectionRequest,
    ) -> Result<String, BtccError> {
        let instruction = butler_core::public_text::trim_js_whitespace(&request.instruction);
        if instruction.is_empty() {
            return Err(error(BtccCode::StewardDirectionInstructionRequired));
        }
        if instruction.chars().count() > 1_200 {
            return Err(error(BtccCode::StewardDirectionInstructionTooLong));
        }
        if request.access_mode == "read_only"
            || !self
                .repository
                .admitted_turn_matches(
                    request.parent_session_id.clone(),
                    request.parent_turn_id.clone(),
                    request.source_message_id.clone(),
                )
                .await
                .map_err(BtccError::from)?
        {
            return Err(error(BtccCode::StewardFollowupAuthorityMismatch));
        }
        Ok(instruction.to_owned())
    }
}
