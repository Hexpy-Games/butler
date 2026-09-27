use super::ContextAssembly;
use crate::btcc::subsessions::{SubsessionMetadata, read_subsession_metadata};
use crate::btcc::{BtccCode, BtccError};
use crate::workspace::StoredSessionBinding;
use butler_core::public_text::trim_js_whitespace;

pub(super) fn read(
    binding: &StoredSessionBinding,
) -> Result<Option<SubsessionMetadata>, BtccError> {
    read_subsession_metadata(
        binding
            .metadata
            .as_ref()
            .and_then(|value| value.get("subsession")),
    )
}

/// The assembly must carry exactly one non-empty EOL profile section in the
/// live configuration; otherwise it fails with `invalid`.
pub(super) fn validate_assembly(
    assembly: &ContextAssembly,
    invalid: BtccCode,
) -> Result<(), BtccError> {
    let mut eol = assembly
        .static_context
        .iter()
        .chain(&assembly.live_configuration)
        .chain(&assembly.runtime_state)
        .chain(&assembly.working_context)
        .chain(&assembly.retrieved_context)
        .chain(&assembly.current_input)
        .filter(|section| section.id == "eol");
    let valid = eol.next().is_some_and(|section| {
        !trim_js_whitespace(&section.content).is_empty()
            && section.region.as_deref() == Some("live_configuration")
            && section.projection_class == "profile"
            && section.scope_kind == "user"
    }) && eol.next().is_none();
    if valid {
        Ok(())
    } else {
        Err(BtccError::detected(invalid, invalid.as_str()))
    }
}
