//! The launchd LaunchAgent: its plist text (every Unix host can render it)
//! and, on macOS, the `launchctl` calls that manage it.

use super::{Definition, LAUNCHD_LABEL};

#[cfg(target_os = "macos")]
pub(super) mod manage;

/// The LaunchAgent plist. `KeepAlive.SuccessfulExit = false` relaunches the
/// service after a crash only: an intentional stop exits 0.
pub(super) fn render(definition: &Definition) -> String {
    let mut lines = vec![
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>".to_owned(),
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">".to_owned(),
        "<plist version=\"1.0\">".to_owned(),
        "<dict>".to_owned(),
        "  <key>Label</key>".to_owned(),
        format!("  <string>{LAUNCHD_LABEL}</string>"),
        "  <key>ProgramArguments</key>".to_owned(),
        "  <array>".to_owned(),
    ];
    let program = definition.program.to_string_lossy();
    for value in std::iter::once(program.as_ref()).chain(definition.args.iter().map(String::as_str))
    {
        lines.push(format!("    <string>{}</string>", xml(value)));
    }
    lines.push("  </array>".to_owned());
    lines.push("  <key>EnvironmentVariables</key>".to_owned());
    lines.push("  <dict>".to_owned());
    for (key, value) in &definition.env {
        lines.push(format!("    <key>{}</key>", xml(key)));
        lines.push(format!("    <string>{}</string>", xml(value)));
    }
    lines.push("  </dict>".to_owned());
    lines.push("  <key>WorkingDirectory</key>".to_owned());
    lines.push(format!(
        "  <string>{}</string>",
        xml(&definition.working_dir.to_string_lossy())
    ));
    lines.extend(
        [
            "  <key>RunAtLoad</key>",
            "  <true/>",
            "  <key>KeepAlive</key>",
            "  <dict>",
            "    <key>SuccessfulExit</key>",
            "    <false/>",
            "  </dict>",
            "</dict>",
            "</plist>",
        ]
        .map(str::to_owned),
    );
    lines.push(String::new());
    lines.join("\n")
}

/// Escapes text for an XML element.
pub(super) fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
