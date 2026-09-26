use super::ContextAssembly;
use crate::btcc::BtccError;
use crate::btcc::subsessions::{SubsessionMetadata, read_subsession_metadata};
use crate::public_text::trim_js_whitespace;
use crate::workspace::StoredSessionBinding;

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

pub(super) fn validate_assembly(
    assembly: &ContextAssembly,
    steward: bool,
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
    } else if steward {
        Err(BtccError::new(
            "subsession_context_assembly_invalid",
            "subsession_context_assembly_invalid",
        ))
    } else {
        Err(BtccError::new(
            "butler_eol_context_assembly_invalid",
            "butler_eol_context_assembly_invalid",
        ))
    }
}
