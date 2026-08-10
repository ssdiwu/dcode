import Foundation

enum PlanItemStatus: String, Sendable, Equatable {
    case pending
    case active
    case inProgress = "in_progress"
    case done
    case blocked
    case paused
    case abandoned
    case unknown

    init(_ value: String?) {
        self = value.flatMap(Self.init(rawValue:)) ?? .unknown
    }

    var isTerminal: Bool { self == .done || self == .abandoned }

    var label: String {
        switch self {
        case .pending: "待处理"
        case .active: "进行中"
        case .inProgress: "进行中"
        case .done: "完成"
        case .blocked: "阻塞"
        case .paused: "暂停"
        case .abandoned: "放弃"
        case .unknown: "未知"
        }
    }
}

struct PlanItemPresentation: Identifiable, Sendable, Equatable {
    let id: String
    let subject: String
    let description: String?
    let status: PlanItemStatus
    let blockedBy: [String]
}

struct PlanPhasePresentation: Identifiable, Sendable, Equatable {
    let id: String
    let subject: String
    let status: PlanItemStatus
    let items: [PlanItemPresentation]
}

struct ActivePlanPresentation: Identifiable, Sendable, Equatable {
    let id: String
    let objective: String
    let status: PlanItemStatus
    let phases: [PlanPhasePresentation]
    let rootItems: [PlanItemPresentation]
    let completedCount: Int
    let totalCount: Int
    let currentItem: PlanItemPresentation?
    let currentPhase: PlanPhasePresentation?

    var progress: Double {
        guard totalCount > 0 else { return 0 }
        return Double(completedCount) / Double(totalCount)
    }

    var currentLabel: String {
        currentItem?.subject ?? currentPhase?.subject ?? "等待下一步"
    }

    var allItems: [PlanItemPresentation] {
        rootItems + phases.flatMap(\.items)
    }
}

enum ActivePlanParser {
    static func parse(_ value: JSONValue?) -> ActivePlanPresentation? {
        guard let goal = value?.objectValue,
              let id = identifier(goal["id"]),
              let objective = goal["objective"]?.stringValue,
              !objective.isEmpty else { return nil }
        let status = PlanItemStatus(goal["status"]?.stringValue)
        guard !status.isTerminal, status != .unknown else { return nil }
        let workList = goal["workList"]?.objectValue ?? [:]
        let rootItems = parseItems(workList["items"])
        let phases = (workList["phases"]?.arrayValue ?? []).compactMap(parsePhase)
        let allItems = rootItems + phases.flatMap(\.items)
        let completed = allItems.filter { $0.status.isTerminal }.count
        let currentItem = allItems.first(where: { $0.status == .active })
            ?? allItems.first(where: { $0.status == .inProgress })
            ?? allItems.first(where: { $0.status == .blocked })
            ?? firstReadyPending(in: allItems)
        let currentPhase = phases.first(where: { $0.status == .active })
            ?? phases.first(where: { $0.status == .inProgress })
            ?? phases.first(where: { phase in phase.items.contains(where: { $0.id == currentItem?.id }) })
            ?? phases.first(where: { !$0.status.isTerminal })
        return ActivePlanPresentation(
            id: id,
            objective: objective,
            status: status,
            phases: phases,
            rootItems: rootItems,
            completedCount: completed,
            totalCount: allItems.count,
            currentItem: currentItem,
            currentPhase: currentPhase
        )
    }

    private static func parsePhase(_ value: JSONValue) -> PlanPhasePresentation? {
        guard let object = value.objectValue,
              let id = identifier(object["id"]),
              let subject = object["subject"]?.stringValue else { return nil }
        return PlanPhasePresentation(
            id: id,
            subject: subject,
            status: PlanItemStatus(object["status"]?.stringValue),
            items: parseItems(object["items"])
        )
    }

    private static func parseItems(_ value: JSONValue?) -> [PlanItemPresentation] {
        (value?.arrayValue ?? []).compactMap { item in
            guard let object = item.objectValue,
                  let id = identifier(object["id"]),
                  let subject = object["subject"]?.stringValue else { return nil }
            return PlanItemPresentation(
                id: id,
                subject: subject,
                description: object["description"]?.stringValue,
                status: PlanItemStatus(object["status"]?.stringValue),
                blockedBy: (object["blockedBy"]?.arrayValue ?? []).compactMap(identifier)
            )
        }
    }

    private static func firstReadyPending(in items: [PlanItemPresentation]) -> PlanItemPresentation? {
        let terminalIDs = Set(items.filter { $0.status.isTerminal }.map(\.id))
        return items.first(where: { item in
            item.status == .pending && item.blockedBy.allSatisfy(terminalIDs.contains)
        }) ?? items.first(where: { $0.status == .pending })
    }

    private static func identifier(_ value: JSONValue?) -> String? {
        if let string = value?.stringValue { return string }
        if let number = value?.intValue { return String(number) }
        return nil
    }
}
