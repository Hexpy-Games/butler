import AppKit
import Darwin
import Foundation

struct AgentMenuState {
    let label: String
    let canStart: Bool
    let canStop: Bool
    let canRestart: Bool
}

final class MenuBarHelperApp: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var refreshTimer: Timer?
    private var lockFileDescriptor: Int32 = -1
    private let environment = ProcessInfo.processInfo.environment

    private var serviceLabel: String {
        nonEmpty(environment["BUTLER_APP_AGENT_SERVICE_LABEL"]) ?? "com.hexpy.butler"
    }

    private var launchAgentPlistPath: String {
        let home = NSHomeDirectory()
        return "\(home)/Library/LaunchAgents/\(serviceLabel).plist"
    }

    private var pidFilePath: String? {
        nonEmpty(environment["BUTLER_APP_MENU_BAR_HELPER_PID_FILE"])
    }

    private var lockFilePath: String? {
        guard let pidFilePath else {
            return nil
        }
        return URL(fileURLWithPath: pidFilePath)
            .deletingLastPathComponent()
            .appendingPathComponent("menu-bar-helper.lock")
            .path
    }

    private var suppressStopWarning: Bool {
        UserDefaults.standard.bool(forKey: "SuppressStopButlerAgentWarning")
    }

    private var mainExecutablePath: String? {
        nonEmpty(environment["BUTLER_APP_MAIN_EXECUTABLE"])
    }

    private var mainAppBundlePath: String? {
        if let path = nonEmpty(environment["BUTLER_APP_BUNDLE_PATH"]) {
            return path
        }
        if let executable = mainExecutablePath {
            var url = URL(fileURLWithPath: executable)
            url.deleteLastPathComponent()
            url.deleteLastPathComponent()
            url.deleteLastPathComponent()
            return url.path
        }
        var url = Bundle.main.bundleURL
        for _ in 0..<4 {
            url.deleteLastPathComponent()
        }
        return url.path
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        guard acquireSingletonLock() else {
            NSApp.terminate(nil)
            return
        }
        terminateDuplicateHelperApplications()
        if existingHelperPidIsRunning() {
            releaseSingletonLock()
            NSApp.terminate(nil)
            return
        }
        writePidFile()
        installStatusItem()
        rebuildMenu()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.rebuildMenu()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        removePidFile()
        releaseSingletonLock()
    }

    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            if let icon = loadStatusIcon() {
                icon.size = NSSize(width: 18, height: 18)
                icon.isTemplate = true
                button.image = icon
            } else {
                button.title = "Butler"
            }
        }
        statusItem = item
    }

    private func loadStatusIcon() -> NSImage? {
        if let menuBarIconURL = Bundle.main.url(forResource: "butler-mark-flat", withExtension: "png"),
           let image = NSImage(contentsOf: menuBarIconURL) {
            return image
        }
        if let iconURL = Bundle.main.url(forResource: "butler", withExtension: "icns") {
            return NSImage(contentsOf: iconURL)
        }
        return nil
    }

    private func rebuildMenu() {
        let service = agentMenuState()
        let menu = NSMenu()
        menu.addItem(menuItem("Open Butler", action: #selector(openButler)))
        menu.addItem(NSMenuItem.separator())
        let status = menuItem(service.label, action: nil)
        status.isEnabled = false
        menu.addItem(status)
        let start = menuItem("Start Butler Agent", action: #selector(startAgent))
        start.isEnabled = service.canStart
        menu.addItem(start)
        let restart = menuItem("Restart Butler Agent", action: #selector(restartAgent))
        restart.isEnabled = service.canRestart
        menu.addItem(restart)
        let stop = menuItem("Stop Butler Agent", action: #selector(stopAgent))
        stop.isEnabled = service.canStop
        menu.addItem(stop)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(menuItem("New Chat", action: #selector(newChat)))
        statusItem?.menu = menu
    }

    private func menuItem(_ title: String, action: Selector?) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        return item
    }

    private func agentMenuState() -> AgentMenuState {
        let result = runLaunchctl(["print", "gui/\(getuid())/\(serviceLabel)"])
        if result.exitCode != 0 {
            if FileManager.default.fileExists(atPath: launchAgentPlistPath) {
                return AgentMenuState(
                    label: "Butler Agent: Stopped",
                    canStart: true,
                    canStop: false,
                    canRestart: false
                )
            }
            return AgentMenuState(
                label: "Butler Agent: Not Installed",
                canStart: false,
                canStop: false,
                canRestart: false
            )
        }
        if result.output.contains("state = running") {
            return AgentMenuState(
                label: "Butler Agent: Running",
                canStart: false,
                canStop: true,
                canRestart: true
            )
        }
        return AgentMenuState(
            label: "Butler Agent: Stopped",
            canStart: true,
            canStop: false,
            canRestart: false
        )
    }

    @objc private func openButler() {
        openMainAppBundle()
    }

    @objc private func newChat() {
        launchMainExecutable(arguments: ["--butler-new-chat"])
    }

    @objc private func startAgent() {
        if FileManager.default.fileExists(atPath: launchAgentPlistPath) {
            _ = runLaunchctl(["bootstrap", "gui/\(getuid())", launchAgentPlistPath])
        }
        _ = runLaunchctl(["kickstart", "-k", "gui/\(getuid())/\(serviceLabel)"])
        rebuildMenu()
    }

    @objc private func restartAgent() {
        _ = runLaunchctl(["kickstart", "-k", "gui/\(getuid())/\(serviceLabel)"])
        rebuildMenu()
    }

    @objc private func stopAgent() {
        guard confirmStopButlerAgent() else {
            return
        }
        _ = runLaunchctl(["bootout", "gui/\(getuid())/\(serviceLabel)"])
        rebuildMenu()
        NSApp.terminate(nil)
    }

    private func confirmStopButlerAgent() -> Bool {
        if suppressStopWarning {
            return true
        }
        let alert = NSAlert()
        alert.messageText = "Stop Butler Agent?"
        alert.informativeText = "Stopping Butler Agent will stop automations and any background sessions currently running."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Stop Butler Agent")
        alert.addButton(withTitle: "Cancel")
        let suppression = NSButton(checkboxWithTitle: "Do not show this warning again", target: nil, action: nil)
        alert.accessoryView = suppression
        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else {
            return false
        }
        if suppression.state == .on {
            UserDefaults.standard.set(true, forKey: "SuppressStopButlerAgentWarning")
        }
        return true
    }

    private func openMainAppBundle() {
        guard let bundlePath = mainAppBundlePath else {
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.environment = mainAppEnvironment()
        NSWorkspace.shared.openApplication(
            at: URL(fileURLWithPath: bundlePath),
            configuration: configuration
        )
    }

    private func launchMainExecutable(arguments: [String]) {
        guard let executable = mainExecutablePath else {
            openMainAppBundle()
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = mainAppEnvironment()
        do {
            try process.run()
        } catch {
            openMainAppBundle()
        }
    }

    private func mainAppEnvironment() -> [String: String] {
        var env = environment
        env["BUTLER_APP_MENU_BAR_HELPER"] = ""
        env["BUTLER_APP_MENU_BAR_HELPER_PID_FILE"] = ""
        return env
    }

    private func runLaunchctl(_ arguments: [String]) -> (exitCode: Int32, output: String) {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""
            return (process.terminationStatus, output)
        } catch {
            return (1, String(describing: error))
        }
    }

    private func terminateDuplicateHelperApplications() {
        guard let bundleIdentifier = Bundle.main.bundleIdentifier else {
            return
        }
        let currentPid = getpid()
        let duplicates = NSWorkspace.shared.runningApplications.filter { application in
            application.bundleIdentifier == bundleIdentifier &&
                application.processIdentifier != currentPid
        }
        guard !duplicates.isEmpty else {
            return
        }
        for application in duplicates {
            application.terminate()
        }
        let deadline = Date().addingTimeInterval(1)
        while Date() < deadline && duplicates.contains(where: { !$0.isTerminated }) {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        for application in duplicates where !application.isTerminated {
            application.forceTerminate()
        }
    }

    private func existingHelperPidIsRunning() -> Bool {
        guard
            let path = pidFilePath,
            let contents = try? String(contentsOfFile: path, encoding: .utf8),
            let pid = Int32(contents.trimmingCharacters(in: .whitespacesAndNewlines)),
            pid > 0,
            pid != getpid()
        else {
            return false
        }
        return processIsRunning(pid) && processLooksLikeCurrentHelper(pid)
    }

    private func processLooksLikeCurrentHelper(_ pid: Int32) -> Bool {
        guard
            let expectedBundleIdentifier = Bundle.main.bundleIdentifier,
            let application = NSRunningApplication(processIdentifier: pid),
            let bundleIdentifier = application.bundleIdentifier
        else {
            return false
        }
        return bundleIdentifier == expectedBundleIdentifier
    }

    private func processIsRunning(_ pid: Int32) -> Bool {
        if kill(pid, 0) == 0 {
            return true
        }
        return errno == EPERM
    }

    private func acquireSingletonLock() -> Bool {
        guard let path = lockFilePath else {
            return true
        }
        let url = URL(fileURLWithPath: path)
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
        } catch {
            NSLog("Butler menu bar helper could not create lock directory: \(error)")
            return false
        }
        let descriptor = open(path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else {
            NSLog("Butler menu bar helper could not open singleton lock: \(path)")
            return false
        }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor)
            return false
        }
        lockFileDescriptor = descriptor
        return true
    }

    private func releaseSingletonLock() {
        guard lockFileDescriptor >= 0 else {
            return
        }
        flock(lockFileDescriptor, LOCK_UN)
        close(lockFileDescriptor)
        lockFileDescriptor = -1
    }

    private func writePidFile() {
        guard let path = pidFilePath else {
            return
        }
        let url = URL(fileURLWithPath: path)
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try "\(getpid())\n".write(to: url, atomically: true, encoding: .utf8)
        } catch {
            NSLog("Butler menu bar helper could not write pid file: \(error)")
        }
    }

    private func removePidFile() {
        guard let path = pidFilePath else {
            return
        }
        let url = URL(fileURLWithPath: path)
        guard
            let contents = try? String(contentsOf: url, encoding: .utf8),
            Int(contents.trimmingCharacters(in: .whitespacesAndNewlines)) == Int(getpid())
        else {
            return
        }
        try? FileManager.default.removeItem(at: url)
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return value
    }
}

let app = NSApplication.shared
let delegate = MenuBarHelperApp()
app.delegate = delegate
app.run()
