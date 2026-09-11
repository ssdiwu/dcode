import ApplicationServices
import Foundation
func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
    return value
}
func button(_ element: AXUIElement, title: String, depth: Int = 0) -> AXUIElement? {
    guard depth < 12 else { return nil }
    if attribute(element, kAXRoleAttribute) as? String == kAXButtonRole,
       attribute(element, kAXTitleAttribute) as? String == title { return element }
    for child in attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
        if let result = button(child, title: title, depth: depth + 1) { return result }
    }
    return nil
}
guard CommandLine.arguments.count == 3, let pid = Int32(CommandLine.arguments[1]), pid > 1 else { exit(2) }
if CommandLine.arguments[2] == "windows" {
    let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
    print(windows.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }.count)
    exit(0)
}
guard AXIsProcessTrusted() else { print("accessibility-unavailable"); exit(4) }
let app = AXUIElementCreateApplication(pid)
let title = CommandLine.arguments[2]
for _ in 0..<60 {
    if let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] {
        for window in windows {
            guard let target = button(window, title: title) else { continue }
            var owner: pid_t = 0
            guard AXUIElementGetPid(target, &owner) == .success, owner == pid else { exit(3) }
            guard AXUIElementPerformAction(target, kAXPressAction as CFString) == .success else { exit(3) }
            print("pressed-owned-helper-button"); exit(0)
        }
    }
    Thread.sleep(forTimeInterval: 0.05)
}
print("owned-helper-button-unavailable"); exit(5)
