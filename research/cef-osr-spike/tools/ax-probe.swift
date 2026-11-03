import ApplicationServices
import Foundation
import AppKit
let pid=pid_t(CommandLine.arguments[1])!
func attribute(_ e:AXUIElement,_ name:String)->CFTypeRef? { var value:CFTypeRef?;let error=AXUIElementCopyAttributeValue(e,name as CFString,&value);return error == .success ? value:nil }
var visited=0
func walk(_ e:AXUIElement,_ depth:Int){
 if depth>12 || visited>500{return};visited+=1
 let role=attribute(e,kAXRoleAttribute) as? String ?? "?"
 let title=attribute(e,kAXTitleAttribute) as? String ?? ""
 let value=attribute(e,kAXValueAttribute) as? String ?? ""
 print(String(repeating:" ",count:depth)+role+" "+title+" "+value)
 if let children=attribute(e,kAXChildrenAttribute) as? [AXUIElement]{for child in children{walk(child,depth+1)}}
}
let running=NSRunningApplication(processIdentifier:pid)!
if CommandLine.arguments.contains("--hide") { print("hide=\(running.hide())") }
if CommandLine.arguments.contains("--show") { print("show=\(running.unhide())") }
let app=AXUIElementCreateApplication(pid)
print("trusted=\(AXIsProcessTrusted())")
if let windows=attribute(app,kAXWindowsAttribute) as? [AXUIElement]{
 for window in windows {walk(window,0)
  if CommandLine.arguments.contains("--minimize") { print("minimize=\(AXUIElementSetAttributeValue(window,kAXMinimizedAttribute as CFString,kCFBooleanTrue).rawValue)") }
  if CommandLine.arguments.contains("--restore") { print("restore=\(AXUIElementSetAttributeValue(window,kAXMinimizedAttribute as CFString,kCFBooleanFalse).rawValue)") }
  if CommandLine.arguments.contains("--close"),let close=attribute(window,kAXCloseButtonAttribute){
   let button=unsafeBitCast(close,to:AXUIElement.self)
   print("close_action=\(AXUIElementPerformAction(button,kAXPressAction as CFString).rawValue)")
  }
 }
}
