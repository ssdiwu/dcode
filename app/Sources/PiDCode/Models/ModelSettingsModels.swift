import Foundation

struct ModelSettingsSnapshot: Codable, Equatable, Sendable {
    let cwd: String
    let providers: [ModelSettingsProvider]
    let global: ModelSettingsScope
    let effective: ModelSettingsScope
    let projectOverrides: ModelSettingsProjectOverrides
    let settingsErrors: [ModelSettingsReadIssue]
    let cacheInvalid: Bool
    let refresh: ModelSettingsRefreshState

    var globalDefaultModel: ModelSettingsModel? {
        guard let provider = global.defaultProvider,
              let modelID = global.defaultModelId else { return nil }
        return providers.lazy
            .flatMap(\.models)
            .first(where: { $0.model.provider == provider && $0.model.id == modelID })
    }

    var selectableDefaultModels: [ModelSettingsModel] {
        providers.flatMap(\.models).filter { model in
            model.globalEnabled
                && providers.first(where: { $0.id == model.model.provider })?.auth.configured == true
        }
    }
}

struct ModelSettingsProvider: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let name: String
    let auth: ModelSettingsAuthState
    let catalog: ModelSettingsCatalogState
    let models: [ModelSettingsModel]
}

struct ModelSettingsAuthState: Codable, Equatable, Sendable {
    let configured: Bool
    let source: String?
    let methods: [ModelSettingsAuthMethod]?

    var availableMethods: [ModelSettingsAuthMethod] { methods ?? [] }
}

struct ModelSettingsAuthMethod: Codable, Equatable, Sendable, Identifiable {
    let type: String
    let label: String
    let interactive: Bool

    var id: String { type }
}

struct ModelSettingsCatalogState: Codable, Equatable, Sendable {
    let kind: String
    let checkedAt: String?
    let lastModified: String?
    let refreshFailed: Bool
}

struct ModelSettingsModel: Codable, Equatable, Sendable, Identifiable {
    let model: HostModel
    let globalEnabled: Bool
    let enabled: Bool
    let globalMatchedPatterns: [String]
    let matchedPatterns: [String]

    var id: String { model.qualifiedName }
    var isExactlyEnabled: Bool { globalMatchedPatterns.contains(model.qualifiedName) }
    var canRemoveExactRule: Bool { isExactlyEnabled && globalMatchedPatterns.count == 1 }
}

struct ModelSettingsScope: Codable, Equatable, Sendable {
    let enabledModels: [String]
    let unrestricted: Bool
    let defaultProvider: String?
    let defaultModelId: String?
    let defaultInScope: Bool?
    let diagnostics: [ModelSettingsPatternDiagnostic]
}

struct ModelSettingsPatternDiagnostic: Codable, Equatable, Sendable, Identifiable {
    let code: String
    let message: String
    let pattern: String?

    var id: String { "\(code):\(pattern ?? message)" }
}

struct ModelSettingsProjectOverrides: Codable, Equatable, Sendable {
    let enabledModels: Bool
    let defaultModel: Bool

    var isActive: Bool { enabledModels || defaultModel }
}

struct ModelSettingsReadIssue: Codable, Equatable, Sendable, Identifiable {
    let scope: String
    let message: String

    var id: String { "\(scope):\(message)" }
}

struct ModelSettingsRefreshState: Codable, Equatable, Sendable {
    let attempted: Bool
    let aborted: Bool
    let failed: Bool
    let networkDisabled: Bool

    var statusMessage: String? {
        if networkDisabled {
            return "当前为离线模式，已保留本地模型目录；刷新不会访问网络。"
        }
        if aborted {
            return "目录刷新超时或已中止，已保留刷新前目录。"
        }
        if failed {
            return "目录刷新失败，已保留刷新前目录；可稍后重试。"
        }
        return nil
    }
}

enum ModelSettingsRulePolicy {
    static func normalized(_ rules: [String]) -> [String] {
        var seen = Set<String>()
        return rules.compactMap { raw in
            let rule = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !rule.isEmpty, seen.insert(rule).inserted else { return nil }
            return rule
        }
    }

    static func addingExactModel(_ model: ModelSettingsModel, to rules: [String]) -> [String] {
        normalized(rules + [model.model.qualifiedName])
    }

    static func removingExactModel(_ model: ModelSettingsModel, from rules: [String]) -> [String] {
        rules.filter { $0 != model.model.qualifiedName }
    }
}

struct ModelAuthPromptOption: Equatable, Sendable, Identifiable {
    let id: String
    let label: String
    let description: String?
}

struct ModelAuthPrompt: Equatable, Sendable, Identifiable {
    let id: String
    let flowID: String
    let type: String
    let message: String
    let placeholder: String?
    let options: [ModelAuthPromptOption]

    init?(data: JSONValue?) {
        guard let object = data?.objectValue,
              let id = object["requestId"]?.stringValue,
              let flowID = object["flowId"]?.stringValue,
              let prompt = object["prompt"]?.objectValue,
              let type = prompt["type"]?.stringValue,
              let message = prompt["message"]?.stringValue else { return nil }
        self.id = id
        self.flowID = flowID
        self.type = type
        self.message = DiagnosticSanitizer.redact(message, limit: 8_192)
        placeholder = prompt["placeholder"]?.stringValue.map {
            DiagnosticSanitizer.redact($0, limit: 2_048)
        }
        options = prompt["options"]?.arrayValue?.compactMap { value in
            guard let option = value.objectValue,
                  let id = option["id"]?.stringValue,
                  let label = option["label"]?.stringValue else { return nil }
            return ModelAuthPromptOption(
                id: id,
                label: DiagnosticSanitizer.redact(label, limit: 2_048),
                description: option["description"]?.stringValue.map {
                    DiagnosticSanitizer.redact($0, limit: 4_096)
                }
            )
        } ?? []
    }
}

struct ModelAuthEventPresentation: Equatable, Sendable {
    let type: String
    let message: String?
    let url: String?
    let linkLabel: String?
    let userCode: String?

    init?(data: JSONValue?) {
        guard let event = data?["event"]?.objectValue,
              let type = event["type"]?.stringValue else { return nil }
        self.type = type
        message = (event["message"]?.stringValue ?? event["instructions"]?.stringValue).map {
            DiagnosticSanitizer.redact($0, limit: 8_192)
        }
        let firstLink = event["links"]?.arrayValue?.first?.objectValue
        url = event["url"]?.stringValue
            ?? event["verificationUri"]?.stringValue
            ?? firstLink?["url"]?.stringValue
        linkLabel = firstLink?["label"]?.stringValue.map {
            DiagnosticSanitizer.redact($0, limit: 2_048)
        }
        userCode = event["userCode"]?.stringValue
    }
}

struct ModelAuthFlow: Equatable, Sendable, Identifiable {
    let id: String
    let providerID: String
    let providerName: String
    let method: ModelSettingsAuthMethod
    var prompt: ModelAuthPrompt?
    var events: [ModelAuthEventPresentation]
    var error: String?
}

struct ModelAuthCancelResult: Codable, Equatable, Sendable {
    let cancelled: Bool
}
