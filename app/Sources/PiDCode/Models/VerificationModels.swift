import Foundation

/// 单条运行证据：一次真实 bash 工具执行的命令、退出推导、时间与环境。
/// 事实来源是 Host 转发的 tool_execution 事件，不是 Agent 文案。
struct VerificationEvidenceRecord: Codable, Identifiable, Equatable, Sendable {
    let recordId: String
    let sessionId: String
    let runId: String
    let toolCallId: String
    let command: String
    let exitKind: String
    let exitCode: Int?
    let startedAt: Date
    let endedAt: Date
    let cwd: String
    let modelProvider: String?
    let modelId: String?
    var gitRevision: String?

    var id: String { recordId }

    var durationMs: Int {
        max(0, Int(endedAt.timeIntervalSince(startedAt) * 1_000))
    }

    var isFailure: Bool { exitKind == "failure" }
    var isUnknown: Bool { exitKind == "unknown" }
}

enum VerificationExitParser {
    static let exitCodePattern = try? NSRegularExpression(pattern: #"exited with code (\d+)"#)

    /// 从工具结果推导退出状态：成功事件无独立 exit 字段，
    /// 失败时从 "Command exited with code N" 文本提取，无法辨认标 unknown。
    static func parse(isError: Bool, resultText: String?) -> (kind: String, code: Int?) {
        guard isError else { return ("ok", 0) }
        guard let text = resultText,
              let pattern = exitCodePattern,
              let match = pattern.firstMatch(
                  in: text,
                  range: NSRange(text.startIndex..., in: text)
              ),
              let codeRange = Range(match.range(at: 1), in: text),
              let code = Int(text[codeRange])
        else { return ("unknown", nil) }
        return ("failure", code)
    }
}

struct VerificationEvidenceDocument: Codable, Equatable, Sendable {
    let version: Int
    var records: [VerificationEvidenceRecord]
}

/// 本机证据账本：版本化 JSON + 原子写 + 上限与失败熔断（仿会话变更账本）。
actor VerificationEvidenceStore {
    static let maximumRecords = 5_000

    private let fileURL: URL
    private var document: VerificationEvidenceDocument
    private var writeFailed = false
    private var dirty = false

    init(fileURL: URL) {
        self.fileURL = fileURL
        if let data = try? Data(contentsOf: fileURL),
           let decoded = try? JSONDecoder().decode(VerificationEvidenceDocument.self, from: data),
           decoded.version == 1 {
            document = VerificationEvidenceDocument(
                version: 1,
                records: Array(decoded.records.suffix(Self.maximumRecords))
            )
        } else {
            document = VerificationEvidenceDocument(version: 1, records: [])
        }
    }

    func records(sessionId: String) -> [VerificationEvidenceRecord] {
        document.records
            .filter { $0.sessionId == sessionId }
            .sorted { $0.endedAt > $1.endedAt }
    }

    func allRecords() -> [VerificationEvidenceRecord] {
        document.records
    }

    func append(_ record: VerificationEvidenceRecord) async {
        guard !writeFailed else { return }
        document.records.removeAll { $0.recordId == record.recordId }
        document.records.append(record)
        if document.records.count > Self.maximumRecords {
            document.records = Array(document.records.suffix(Self.maximumRecords))
        }
        dirty = true
        await save()
    }

    func updateRevision(recordId: String, revision: String) async {
        guard !writeFailed else { return }
        guard let index = document.records.firstIndex(where: { $0.recordId == recordId }) else { return }
        document.records[index].gitRevision = revision
        dirty = true
        await save()
    }

    func save() async {
        guard dirty, !writeFailed else { return }
        let snapshot = document
        let target = fileURL
        let written: Bool = await Task.detached(priority: .utility) {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            encoder.dateEncodingStrategy = .iso8601
            guard let data = try? encoder.encode(snapshot) else { return false }
            do {
                try FileManager.default.createDirectory(
                    at: target.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try data.write(to: target, options: .atomic)
                return true
            } catch {
                return false
            }
        }.value
        writeFailed = !written
        if written { dirty = false }
    }
}
