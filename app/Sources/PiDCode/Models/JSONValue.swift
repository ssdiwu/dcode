import Foundation

enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case let .bool(value):
            try container.encode(value)
        case let .number(value):
            try container.encode(value)
        case let .string(value):
            try container.encode(value)
        case let .array(value):
            try container.encode(value)
        case let .object(value):
            try container.encode(value)
        }
    }

    var objectValue: [String: JSONValue]? {
        guard case let .object(value) = self else { return nil }
        return value
    }

    var arrayValue: [JSONValue]? {
        guard case let .array(value) = self else { return nil }
        return value
    }

    var stringValue: String? {
        guard case let .string(value) = self else { return nil }
        return value
    }

    var boolValue: Bool? {
        guard case let .bool(value) = self else { return nil }
        return value
    }

    var intValue: Int? {
        guard case let .number(value) = self,
              value.rounded() == value,
              value >= Double(Int.min),
              value < Double(Int.max) else { return nil }
        return Int(value)
    }

    subscript(key: String) -> JSONValue? {
        objectValue?[key]
    }

    func decoded<T: Decodable>(_ type: T.Type, decoder: JSONDecoder = JSONDecoder()) throws -> T {
        try decoder.decode(type, from: JSONEncoder().encode(self))
    }

    var prettyPrinted: String {
        guard let data = try? JSONSerialization.data(
            withJSONObject: foundationObject,
            options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed]
        ) else { return description }
        return String(data: data, encoding: .utf8) ?? description
    }

    var description: String {
        switch self {
        case .null: "null"
        case let .bool(value): value ? "true" : "false"
        case let .number(value): value.formatted()
        case let .string(value): value
        case .array, .object: prettyPrinted
        }
    }

    private var foundationObject: Any {
        switch self {
        case .null: NSNull()
        case let .bool(value): value
        case let .number(value): value
        case let .string(value): value
        case let .array(value): value.map(\.foundationObject)
        case let .object(value): value.mapValues(\.foundationObject)
        }
    }
}

extension Dictionary where Key == String, Value == JSONValue {
    var jsonValue: JSONValue { .object(self) }
}
