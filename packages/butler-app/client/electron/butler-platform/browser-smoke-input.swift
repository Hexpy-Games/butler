// Native input driver for isolated Electron smokes. Require the owned App in front.
import AppKit

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 4, let pid = Int32(args[0]), pid > 0,
      let x = Double(args[2]), let y = Double(args[3]) else {
    fatalError("Expected owned PID, action, screen x, screen y")
}
guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
    fatalError("Owned App is not frontmost; refusing global input")
}
let point = CGPoint(x: x, y: y)
func send(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton = .left, _ count: Int64 = 1) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type,
                              mouseCursorPosition: point, mouseButton: button) else {
        fatalError("Could not create native mouse event")
    }
    event.setIntegerValueField(.mouseEventClickState, value: count)
    event.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.035)
}
switch args[1] {
case "move":
    send(.mouseMoved, point)
case "click", "right", "double":
    let right = args[1] == "right"
    let button: CGMouseButton = right ? .right : .left
    send(.mouseMoved, point)
    for count in 1...(args[1] == "double" ? 2 : 1) {
        send(right ? .rightMouseDown : .leftMouseDown, point, button, Int64(count))
        send(right ? .rightMouseUp : .leftMouseUp, point, button, Int64(count))
    }
case "drag":
    guard args.count == 6, let endX = Double(args[4]), let endY = Double(args[5]) else {
        fatalError("Drag requires destination screen x and y")
    }
    send(.mouseMoved, point)
    send(.leftMouseDown, point)
    for step in 1...20 {
        let fraction = Double(step) / 20
        send(.leftMouseDragged, CGPoint(x: x + (endX - x) * fraction, y: y + (endY - y) * fraction))
    }
    send(.leftMouseUp, CGPoint(x: endX, y: endY))
case "wheel":
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
                              wheelCount: 1, wheel1: -220, wheel2: 0, wheel3: 0) else {
        fatalError("Could not create native wheel event")
    }
    send(.mouseMoved, point)
    event.location = point
    event.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.1)
default:
    fatalError("Unsupported native input action")
}
