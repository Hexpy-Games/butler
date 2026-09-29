//! A `.cmd` batch file.

use super::Target;

pub(super) const FILE_NAME: &str = "butler.cmd";
/// The second line of every launcher this host writes.
pub(super) const MARKER_LINE: &str = "REM butler-native-launcher v1";

pub(super) fn render(target: &Target<'_>) -> String {
    let data = target.data_default.map_or_else(String::new, |data| {
        format!(
            "if not defined BUTLER_DATA set \"BUTLER_DATA={}\"\r\n",
            data.display()
        )
    });
    format!(
        "@echo off\r\n{MARKER_LINE}\r\nREM Managed by Butler: rewritten by the installer.\r\n\
         {data}\"{program}\" --installation-root \"{root}\" --resource-root \"{resources}\" %*\r\n",
        program = target.program.display(),
        root = target.installation_root.display(),
        resources = target.resource_root.display(),
    )
}
