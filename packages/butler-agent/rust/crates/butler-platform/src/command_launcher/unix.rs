//! A POSIX shell script.

use std::path::Path;

use super::Target;

pub(super) const FILE_NAME: &str = "butler";
/// The second line of every launcher this host writes.
pub(super) const MARKER_LINE: &str = "# butler-native-launcher v1";

pub(super) fn render(target: &Target<'_>) -> String {
    let data = target.data_default.map_or_else(String::new, |data| {
        format!(
            "BUTLER_DATA=\"${{BUTLER_DATA:-{}}}\"\nexport BUTLER_DATA\n",
            double_quoted(data)
        )
    });
    format!(
        "#!/bin/sh\n{MARKER_LINE}\n# Managed by Butler: rewritten by the installer.\n\
         {data}exec {program} --installation-root {root} --resource-root {resources} \"$@\"\n",
        program = single_quoted(target.program),
        root = single_quoted(target.installation_root),
        resources = single_quoted(target.resource_root),
    )
}

fn single_quoted(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

/// Escapes a path for use inside `"..."` in a POSIX shell.
fn double_quoted(path: &Path) -> String {
    let mut out = String::new();
    for character in path.to_string_lossy().chars() {
        if matches!(character, '"' | '\\' | '$' | '`') {
            out.push('\\');
        }
        out.push(character);
    }
    out
}
