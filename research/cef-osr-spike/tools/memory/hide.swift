import AppKit
// Hides another app the way Cmd-H does (posts NSApplicationDidHideNotification in it).
// hide() can return false for an app hidden asynchronously, so wait for isHidden instead.
let pid = pid_t(CommandLine.arguments[1])!
guard let app = NSRunningApplication(processIdentifier: pid) else { exit(1) }
_ = app.hide()
for _ in 0..<30 where !app.isHidden { RunLoop.main.run(until: Date().addingTimeInterval(0.1)) }
exit(app.isHidden ? 0 : 1)
