//! UI diff details remain in the immutable journal, never in model projections.
use butler_core::json::{JsonError, visit_raw_array, visit_raw_object};
use butler_turn::btcc::BtccError;

pub(in crate::host::guided::tools::message) fn without_details(
    raw: &str,
) -> Result<String, BtccError> {
    let mut output = String::with_capacity(raw.len());
    project(raw, &mut output).map_err(|source| super::failure().with_source(source))?;
    Ok(output)
}

fn project(raw: &str, output: &mut String) -> Result<(), JsonError> {
    let raw = raw.trim();
    let mut first = true;
    match raw.as_bytes().first() {
        Some(b'{') => {
            output.push('{');
            visit_raw_object(raw, |key, value| {
                let name: String = serde_json::from_str(key)?;
                if matches!(
                    name.as_str(),
                    "changed_file" | "changed_files" | "changedFiles"
                ) {
                    return Ok(());
                }
                separator(output, &mut first);
                output.push_str(key);
                output.push(':');
                project(value, output)
            })?;
            output.push('}');
        }
        Some(b'[') => {
            output.push('[');
            visit_raw_array(raw, |value| {
                separator(output, &mut first);
                project(value, output)
            })?;
            output.push(']');
        }
        _ => output.push_str(raw),
    }
    Ok(())
}

fn separator(output: &mut String, first: &mut bool) {
    if !*first {
        output.push(',');
    }
    *first = false;
}
