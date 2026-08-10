import Foundation

enum ExtensionDialogMethod: String, Sendable {
    case select
    case confirm
    case input
    case editor
}

struct ExtensionDialog: Identifiable, Sendable, Equatable {
    let id: String
    let method: ExtensionDialogMethod
    let title: String
    let message: String?
    let options: [String]
    let placeholder: String?
    let prefill: String?
    let expiresAt: Date?

    init?(data: JSONValue?) {
        guard let object = data?.objectValue,
              let id = object["requestId"]?.stringValue,
              let methodValue = object["method"]?.stringValue,
              let method = ExtensionDialogMethod(rawValue: methodValue),
              let title = object["title"]?.stringValue else { return nil }
        self.id = id
        self.method = method
        self.title = title
        message = object["message"]?.stringValue
        options = object["options"]?.arrayValue?.compactMap(\.stringValue) ?? []
        placeholder = object["placeholder"]?.stringValue
        prefill = object["prefill"]?.stringValue
        if case let .number(milliseconds) = object["expiresAt"] {
            expiresAt = Date(timeIntervalSince1970: milliseconds / 1_000)
        } else {
            expiresAt = nil
        }
    }
}

struct ExtensionNotice: Identifiable, Sendable, Equatable {
    let id = UUID()
    let message: String
    let level: String
}
