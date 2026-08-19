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
    let evidence: String?
}

struct PlanPhasePresentation: Identifiable, Sendable, Equatable {
    let id: String
    let subject: String
    let status: PlanItemStatus
    let items: [PlanItemPresentation]
    let acceptanceCriteria: [PlanCriterionPresentation]
    let check: PlanCheckPresentation?
}

/// dgoal Plan Contract 的保障档位；soft（无 contract）不伪装任何执行保障。
enum PlanAssuranceProfile: String, Sendable, Equatable {
    case execution
    case goalCheck = "goal_check"
    case stagedCheck = "staged_check"

    var label: String {
        switch self {
        case .execution: "执行计划"
        case .goalCheck: "目标终审"
        case .stagedCheck: "阶段审核"
        }
    }
}

struct PlanCriterionPresentation: Sendable, Equatable {
    let criterion: String
    let evidence: String?
}

/// dgoal 阶段 / 目标独立审核的持久化结果。
struct PlanCheckPresentation: Sendable, Equatable {
    let rawStatus: String
    let modelID: String?
    let checkedAt: Date?

    var isApproved: Bool { rawStatus == "approved" }
    var isRejected: Bool { rawStatus == "rejected" }
    var isError: Bool { rawStatus == "audit_error" }

    var label: String {
        switch rawStatus {
        case "approved": "审核通过"
        case "rejected": "审核未通过"
        case "audit_error": "审核异常"
        default: "审核状态未知"
        }
    }
}

struct PlanContractPresentation: Sendable, Equatable {
    let profile: PlanAssuranceProfile
    let revision: Int?
    let transitions: Int
    let lastTransitionTo: PlanAssuranceProfile?
    let verification: String?
    let acceptanceCriteria: [PlanCriterionPresentation]
    let goalCheck: PlanCheckPresentation?
}

enum PlanPauseReason: String, Sendable, Equatable {
    case userAbort = "user_abort"
    case modelError = "model_error"
    case auditError = "audit_error"
    case noProgress = "no_progress"
    case agentBlocked = "agent_blocked"
    case sessionRecovery = "session_recovery"

    var label: String {
        switch self {
        case .userAbort: "用户中止"
        case .modelError: "模型错误"
        case .auditError: "审核异常"
        case .noProgress: "无进展"
        case .agentBlocked: "代理阻塞"
        case .sessionRecovery: "会话恢复"
        }
    }
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
    let contract: PlanContractPresentation?
    let pauseReasonLabel: String?
    let pauseDetail: String?
    let startedAt: Date?
    let updatedAt: Date?

    /// 无 contract 即 soft Work List；如实标注，不伪装 Until Done 或独立审核。
    var assuranceLabel: String {
        contract?.profile.label ?? "软性清单"
    }

    var isSoftList: Bool { contract == nil }

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

/// dgoal work-v1 条目携带的待批计划提案（goal_plan / staged_plan 的启动门禁载体）。
struct PlanProposalPresentation: Identifiable, Sendable, Equatable {
    let goalID: String
    let objective: String
    let description: String?
    let profile: PlanAssuranceProfile
    let verification: String?
    let acceptanceCriteria: [PlanCriterionPresentation]
    let phaseSubjects: [String]
    let nonGoals: [String]

    var id: String { goalID }
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
            currentPhase: currentPhase,
            contract: parseContract(goal["contract"]),
            pauseReasonLabel: PlanPauseReason(rawValue: goal["pauseReason"]?.stringValue ?? "")?.label,
            pauseDetail: goal["pauseReasonDetail"]?.stringValue,
            startedAt: epochDate(goal["startedAt"]),
            updatedAt: epochDate(goal["updatedAt"])
        )
    }

    static func parseProposal(_ value: JSONValue?) -> PlanProposalPresentation? {
        guard let state = value?.objectValue,
              let goalID = state["goalId"]?.stringValue,
              let proposal = state["proposal"]?.objectValue,
              let objective = proposal["objective"]?.stringValue,
              !objective.isEmpty else { return nil }
        let profile = PlanAssuranceProfile(
            rawValue: proposal["assuranceProfile"]?.stringValue ?? ""
        ) ?? .goalCheck
        return PlanProposalPresentation(
            goalID: goalID,
            objective: objective,
            description: proposal["description"]?.stringValue,
            profile: profile,
            verification: proposal["verification"]?.stringValue,
            acceptanceCriteria: parseCriteria(proposal["acceptanceCriteria"]),
            phaseSubjects: (proposal["phases"]?.arrayValue ?? []).compactMap { $0.objectValue?["subject"]?.stringValue },
            nonGoals: (proposal["nonGoals"]?.arrayValue ?? []).compactMap(\.stringValue)
        )
    }

    private static func parseContract(_ value: JSONValue?) -> PlanContractPresentation? {
        guard let object = value?.objectValue,
              let profile = PlanAssuranceProfile(rawValue: object["profile"]?.stringValue ?? "") else { return nil }
        let transitions = object["transitions"]?.arrayValue ?? []
        let lastTo = transitions.last?.objectValue?["to"]?.stringValue
            .flatMap(PlanAssuranceProfile.init(rawValue:))
        return PlanContractPresentation(
            profile: profile,
            revision: object["revision"]?.intValue,
            transitions: transitions.count,
            lastTransitionTo: lastTo,
            verification: object["verification"]?.stringValue,
            acceptanceCriteria: parseCriteria(object["acceptanceCriteria"]),
            goalCheck: parseCheck(object["goalCheck"])
        )
    }

    private static func parseCheck(_ value: JSONValue?) -> PlanCheckPresentation? {
        guard let object = value?.objectValue,
              let status = object["status"]?.stringValue else { return nil }
        return PlanCheckPresentation(
            rawStatus: status,
            modelID: object["modelId"]?.stringValue,
            checkedAt: epochDate(object["checkedAt"])
        )
    }

    private static func parseCriteria(_ value: JSONValue?) -> [PlanCriterionPresentation] {
        (value?.arrayValue ?? []).compactMap { item in
            guard let object = item.objectValue,
                  let criterion = object["criterion"]?.stringValue,
                  !criterion.isEmpty else { return nil }
            return PlanCriterionPresentation(
                criterion: criterion,
                evidence: object["evidence"]?.stringValue
            )
        }
    }

    private static func parsePhase(_ value: JSONValue) -> PlanPhasePresentation? {
        guard let object = value.objectValue,
              let id = identifier(object["id"]),
              let subject = object["subject"]?.stringValue else { return nil }
        return PlanPhasePresentation(
            id: id,
            subject: subject,
            status: PlanItemStatus(object["status"]?.stringValue),
            items: parseItems(object["items"]),
            acceptanceCriteria: parseCriteria(object["acceptanceCriteria"]),
            check: parseCheck(object["check"])
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
                blockedBy: (object["blockedBy"]?.arrayValue ?? []).compactMap(identifier),
                evidence: object["evidence"]?.stringValue
            )
        }
    }

    private static func firstReadyPending(in items: [PlanItemPresentation]) -> PlanItemPresentation? {
        let terminalIDs = Set(items.filter { $0.status.isTerminal }.map(\.id))
        return items.first(where: { item in
            item.status == .pending && item.blockedBy.allSatisfy(terminalIDs.contains)
        }) ?? items.first(where: { $0.status == .pending })
    }

    private static func epochDate(_ value: JSONValue?) -> Date? {
        guard case let .number(milliseconds)? = value, milliseconds > 0 else { return nil }
        return Date(timeIntervalSince1970: milliseconds / 1_000)
    }

    private static func identifier(_ value: JSONValue?) -> String? {
        if let string = value?.stringValue { return string }
        if let number = value?.intValue { return String(number) }
        return nil
    }
}
