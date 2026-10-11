// Read only the owned smoke App's native popup geometry, in screen DIPs.
import Foundation
import CoreGraphics

guard CommandLine.arguments.count == 2, let pid = Int(CommandLine.arguments[1]), pid > 0 else {
    fatalError("Expected owned App PID")
}
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
let menus = windows.filter {
    ($0[kCGWindowOwnerPID as String] as? Int) == pid &&
    ($0[kCGWindowLayer as String] as? Int) == 101 &&
    ($0[kCGWindowAlpha as String] as? Double) == 1
}.map { $0[kCGWindowBounds as String]! }
let data = try! JSONSerialization.data(withJSONObject: menus)
print(String(data: data, encoding: .utf8)!)
