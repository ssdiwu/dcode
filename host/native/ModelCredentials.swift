import AppKit
import Security
import Darwin

// Private Host child pipe. No secrets in argv, files, public IPC or diagnostics.
private func readObject() throws -> [String: Any] {
    guard let line = readLine(), line.utf8.count <= 1_048_576,
          let data = line.data(using: .utf8),
          let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Failure.invalid }
    return value
}
private func reply(_ object: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}
private enum Failure: Error { case invalid, storage, cancelled }
private func query(_ service: String, _ provider: String? = nil) -> [String: Any] {
    var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
    if let provider { q[kSecAttrAccount as String] = provider }
    return q
}
private func readCredential(_ service: String, _ provider: String) throws -> Any {
    var q = query(service, provider)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    if status == errSecItemNotFound { return NSNull() }
    guard status == errSecSuccess, let data = result as? Data else { throw Failure.storage }
    return try JSONSerialization.jsonObject(with: data)
}
private func writeCredential(_ service: String, _ provider: String, _ value: Any) throws {
    if value is NSNull {
        let status = SecItemDelete(query(service, provider) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure.storage }
        return
    }
    guard let value = value as? [String: Any], let type = value["type"] as? String,
          type == "api_key" || type == "oauth" else { throw Failure.invalid }
    let data = try JSONSerialization.data(withJSONObject: value)
    let attrs: [String: Any] = [kSecValueData as String: data, kSecAttrGeneric as String: Data(type.utf8)]
    let status = SecItemUpdate(query(service, provider) as CFDictionary, attrs as CFDictionary)
    if status == errSecItemNotFound {
        var add = query(service, provider)
        add.merge(attrs) { _, new in new }
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        add[kSecAttrLabel as String] = "D Code · \(provider)"
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw Failure.storage }
    } else if status != errSecSuccess { throw Failure.storage }
}
@MainActor private func prompt(_ object: [String: Any]) throws -> String {
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.accessory)
    NSApp.finishLaunching()
    NSApp.activate(ignoringOtherApps: true)
    let menu = NSMenu()
    let editItem = NSMenuItem()
    let edit = NSMenu(title: "编辑")
    edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit
    menu.addItem(editItem)
    NSApp.mainMenu = menu
    let alert = NSAlert()
    alert.messageText = "D Code · \(object["providerName"] as? String ?? "模型连接")"
    alert.informativeText = String((object["message"] as? String ?? "请在此安全窗口完成连接。密钥只保存在本机钥匙串中。").prefix(4000))
    alert.addButton(withTitle: "继续")
    alert.addButton(withTitle: "取消")
    if object["type"] as? String == "select" {
        let menu = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 440, height: 28))
        let options = object["options"] as? [[String: Any]] ?? []
        for option in options.prefix(128) { menu.addItem(withTitle: String((option["label"] as? String ?? "").prefix(500))) }
        guard !options.isEmpty else { throw Failure.invalid }
        alert.accessoryView = menu
        guard alert.runModal() == .alertFirstButtonReturn else { throw Failure.cancelled }
        return options[menu.indexOfSelectedItem]["id"] as? String ?? ""
    }
    let input = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 440, height: 28))
    input.placeholderString = object["type"] as? String == "manual_code" ? "粘贴浏览器返回的地址或验证码" : "输入后仅交给连接服务"
    alert.accessoryView = input
    alert.window.initialFirstResponder = input
    guard alert.runModal() == .alertFirstButtonReturn else { throw Failure.cancelled }
    return input.stringValue
}
@MainActor @main struct ModelCredentials {
    static func main() {
        let parent = getppid()
        let parentWatch = DispatchSource.makeTimerSource(queue: .global())
        parentWatch.schedule(deadline: .now() + 1, repeating: 1)
        parentWatch.setEventHandler { if getppid() != parent { exit(143) } }
        parentWatch.resume()
        defer { parentWatch.cancel() }
        do {
            let object = try readObject()
            let operation = object["operation"] as? String ?? ""
            if operation == "prompt" { try reply(["value": try prompt(object)]); return }
            if operation == "browser" {
                _ = NSApplication.shared
                guard let text = object["url"] as? String, let url = URL(string: text), url.scheme == "https",
                      url.user == nil, url.password == nil, NSWorkspace.shared.open(url) else { throw Failure.invalid }
                try reply(["ok": true]); return
            }
            if operation == "notice" {
                _ = NSApplication.shared
                NSApp.setActivationPolicy(.accessory)
                NSApp.finishLaunching()
                NSApp.activate(ignoringOtherApps: true)
                let alert = NSAlert()
                alert.messageText = "D Code · 模型连接"
                alert.informativeText = String((object["message"] as? String ?? "").prefix(8000))
                alert.addButton(withTitle: "继续")
                alert.runModal()
                try reply(["ok": true]); return
            }
            guard let service = object["service"] as? String,
                  service.range(of: "^com[.]dcode[.]model-auth[.][a-f0-9]{64}$", options: .regularExpression) != nil else { throw Failure.invalid }
            if operation == "list" {
                var q = query(service)
                q[kSecReturnAttributes as String] = true
                q[kSecMatchLimit as String] = kSecMatchLimitAll
                var result: CFTypeRef?
                let status = SecItemCopyMatching(q as CFDictionary, &result)
                if status == errSecItemNotFound { try reply(["items": []]); return }
                guard status == errSecSuccess, let entries = result as? [[String: Any]] else { throw Failure.storage }
                let items = entries.compactMap { item -> [String: String]? in
                    guard let id = item[kSecAttrAccount as String] as? String,
                          let typeData = item[kSecAttrGeneric as String] as? Data,
                          let type = String(data: typeData, encoding: .utf8) else { return nil }
                    return ["providerId": id, "type": type]
                }
                try reply(["items": items]); return
            }
            guard operation == "transaction", let provider = object["provider"] as? String,
                  provider.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$", options: .regularExpression) != nil,
                  let lockPath = object["lockPath"] as? String else { throw Failure.invalid }
            let fd = open(lockPath, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
            guard fd >= 0 else { throw Failure.storage }
            defer { flock(fd, LOCK_UN); close(fd) }
            var info = stat()
            guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_nlink == 1,
                  info.st_mode & S_IFMT == S_IFREG, flock(fd, LOCK_EX) == 0 else { throw Failure.storage }
            try reply(["credential": try readCredential(service, provider)])
            // Parent performs SDK refresh while this process holds the provider lock.
            let next = try readObject()
            if next["write"] as? Bool == true { try writeCredential(service, provider, next["credential"] ?? NSNull()) }
            try reply(["ok": true])
        } catch Failure.cancelled {
            try? reply(["error": "cancelled"])
            exit(2)
        } catch {
            try? reply(["error": "unavailable"])
            exit(1)
        }
    }
}
