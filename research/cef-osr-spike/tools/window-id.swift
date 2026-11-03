import CoreGraphics
import Foundation
let pid = Int(CommandLine.arguments[1])!
let windows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let own = windows.filter { ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
func area(_ w:[String:Any]) -> Double {let b=w[kCGWindowBounds as String] as? [String:Double] ?? [:];return (b["Width"] ?? 0)*(b["Height"] ?? 0)}
if let w=own.max(by:{area($0)<area($1)}),let id=w[kCGWindowNumber as String] as? Int {print(id)}
