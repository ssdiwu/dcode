import SwiftUI
import XCTest
@testable import PiDCode

/// dgoal 融入（0.0.8）：Work List / Plan Contract 解析、待批提案生命周期、
/// 上下文构成占比与渲染冒烟。
@MainActor
final class DgoalIntegrationTests: XCTestCase {
    // MARK: - 解析

    func testParserReadsStagedContractWithChecksAndEvidence() throws {
        let goal = try JSONValue.jsonObject("""
        {"id":"goal-1","objective":"完成 0.0.8","status":"active",
         "startedAt":1787000000000,"updatedAt":1787000600000,
         "workList":{"items":[
           {"id":"i1","subject":"拆分","status":"done","evidence":"swift test 156/156"},
           {"id":"i2","subject":"批准卡","status":"in_progress"}],
           "phases":[
           {"id":"p1","subject":"阶段一","status":"done",
            "acceptanceCriteria":[{"criterion":"测试全绿","evidence":"npm test"}],
            "check":{"status":"approved","modelId":"openai-codex/gpt-5.6-sol","checkedAt":1787000500000},
            "items":[{"id":"i3","subject":"内核","status":"done"}]}]},
         "contract":{"profile":"staged_check","revision":2,
          "transitions":[{"from":"execution","to":"goal_check","at":1787000100000},
                         {"from":"goal_check","to":"staged_check","at":1787000200000}],
          "acceptanceCriteria":[{"criterion":"真实手测通过","evidence":null}],
          "goalCheck":null}}
        """)
        let plan = try XCTUnwrap(ActivePlanParser.parse(goal))

        XCTAssertEqual(plan.assuranceLabel, "阶段审核")
        XCTAssertFalse(plan.isSoftList)
        XCTAssertEqual(plan.contract?.transitions, 2)
        XCTAssertEqual(plan.contract?.lastTransitionTo, .stagedCheck)
        XCTAssertEqual(plan.contract?.acceptanceCriteria.first?.criterion, "真实手测通过")
        XCTAssertEqual(plan.phases.first?.check?.label, "审核通过")
        XCTAssertEqual(plan.phases.first?.check?.modelID, "openai-codex/gpt-5.6-sol")
        XCTAssertEqual(plan.phases.first?.acceptanceCriteria.first?.criterion, "测试全绿")
        XCTAssertEqual(plan.rootItems.first?.evidence, "swift test 156/156")
        XCTAssertNotNil(plan.startedAt)
    }

    func testParserMarksSoftListHonestly() throws {
        let goal = try JSONValue.jsonObject("""
        {"id":"goal-2","objective":"记录待办","status":"active",
         "workList":{"items":[{"id":"i1","subject":"等用户补充","status":"pending"}],"phases":[]}}
        """)
        let plan = try XCTUnwrap(ActivePlanParser.parse(goal))

        XCTAssertEqual(plan.assuranceLabel, "软性清单")
        XCTAssertNil(plan.contract)
        XCTAssertNil(plan.pauseReasonLabel)
    }

    func testParserKeepsPausedGoalWithReason() throws {
        let goal = try JSONValue.jsonObject("""
        {"id":"goal-3","objective":"暂停的目标","status":"paused",
         "pauseReason":"audit_error","pauseReasonDetail":"审核器不可用",
         "workList":{"items":[],"phases":[]}}
        """)
        let plan = try XCTUnwrap(ActivePlanParser.parse(goal))

        XCTAssertEqual(plan.status, .paused)
        XCTAssertEqual(plan.pauseReasonLabel, "审核异常")
        XCTAssertEqual(plan.pauseDetail, "审核器不可用")
    }

    func testProposalParserReadsPendingUpgrade() throws {
        let pending = try JSONValue.jsonObject("""
        {"goalId":"goal-1","baseFingerprint":"abc",
         "proposal":{"objective":"为 0.0.8 增加终审",
          "assuranceProfile":"goal_check",
          "verification":"npm test && swift test",
          "acceptanceCriteria":[{"criterion":"真实会话手测","evidence":null}],
          "phases":[{"subject":"实现","acceptanceCriteria":[]}],
          "nonGoals":["自动触发升级"]}}
        """)
        let proposal = try XCTUnwrap(ActivePlanParser.parseProposal(pending))

        XCTAssertEqual(proposal.goalID, "goal-1")
        XCTAssertEqual(proposal.profile, .goalCheck)
        XCTAssertEqual(proposal.verification, "npm test && swift test")
        XCTAssertEqual(proposal.phaseSubjects, ["实现"])
        XCTAssertEqual(proposal.nonGoals, ["自动触发升级"])
    }

    // MARK: - 提案生命周期（Fake-host 事件驱动）

    func testPlanChangedDrivesProposalLifecycle() async throws {
        let harness = HostTestHarness()
        await harness.installDefaultScript()
        await harness.model.start()
        harness.model.selectedSessionID = "session-a"

        let proposal = try JSONValue.jsonObject("""
        {"goalId":"goal-1","proposal":{"objective":"升级到终审",
         "assuranceProfile":"goal_check","acceptanceCriteria":[],"phases":[]}}
        """)
        await harness.client.emit(HostEvent(name: "plan.changed", data: .object([
            "plan": .null,
            "proposal": proposal,
        ])))
        XCTAssertEqual(harness.model.pendingPlanProposal?.objective, "升级到终审")

        await harness.client.emit(HostEvent(name: "plan.changed", data: .object([
            "plan": .null,
            "proposal": .null,
        ])))
        XCTAssertNil(harness.model.pendingPlanProposal, "提案被审阅后必须清除")
    }

    func testPlanReviewRequestIsGuardedWhileRunning() async throws {
        let harness = HostTestHarness()
        await harness.installDefaultScript()
        await harness.model.start()
        harness.model.selectedSessionID = "session-a"
        harness.model.activity.currentRunState = SessionRunState(
            sessionID: "session-a",
            runID: "run-a",
            phase: .running,
            waitingFor: nil,
            startedAt: "2026-08-18T08:00:00.000Z",
            updatedAt: "2026-08-18T08:00:00.000Z",
            completionID: nil,
            completionEntryID: nil,
            completedAt: nil,
            inputPersisted: true,
            retryable: false
        )

        await harness.model.requestPlanReview()

        let methods = await harness.client.recordedMethods()
        XCTAssertFalse(methods.contains("session.prompt"), "运行中的审阅请求必须被门禁拦下")
    }

    // MARK: - 上下文构成占比

    func testBreakdownCompositionRowsAndFreeTokens() throws {
        let breakdown = try JSONDecoder().decode(
            ContextBreakdownResult.self,
            from: Data("""
            {"available":true,"estimated":false,"totalTokens":100000,
             "estimatedMessageTokens":82000,"contextWindow":200000,
             "parts":[{"kind":"systemTools","tokens":18000},
                      {"kind":"user","tokens":30000},
                      {"kind":"assistant","tokens":20000},
                      {"kind":"thinking","tokens":12000},
                      {"kind":"toolResult","tokens":20000}]}
            """.utf8)
        )

        let rows = breakdown.compositionRows
        XCTAssertEqual(rows.count, 5)
        XCTAssertEqual(rows.first?.kind, .systemTools)
        XCTAssertEqual(rows.first?.fraction ?? 0, 0.18, accuracy: 0.001)
        XCTAssertEqual(breakdown.freeTokens, 100000)
    }

    func testLoadContextBreakdownRequestsAndStoresResult() async throws {
        let harness = HostTestHarness()
        await harness.client.script { method, _ in
            switch method {
            case "host.hello":
                HostTestHarness.helloValue()
            case "session.list":
                .object(["sessions": .array([])])
            case "session.contextBreakdown":
                .object([
                    "available": .bool(true),
                    "estimated": .bool(true),
                    "totalTokens": .null,
                    "estimatedMessageTokens": .number(5_000),
                    "contextWindow": .number(200_000),
                    "parts": .array([
                        .object(["kind": .string("user"), "tokens": .number(5_000)]),
                    ]),
                ])
            default:
                .object([:])
            }
        }
        await harness.model.start()
        harness.model.selectedSessionID = "session-a"

        await harness.model.loadContextBreakdown()

        let methods = await harness.client.recordedMethods()
        XCTAssertTrue(methods.contains("session.contextBreakdown"))
        XCTAssertEqual(harness.model.contextBreakdown?.compositionRows.first?.kind, .user)
        XCTAssertEqual(harness.model.contextBreakdown?.estimated, true)
    }

    func testContextDeltaAccumulatesAndSeparatesRelease() {
        let model = AppModel()
        model.recordContextUsage(ContextUsage(tokens: 10_000, contextWindow: 200_000, percent: 5))
        XCTAssertEqual(model.contextDelta.isEmpty, true, "首个观测只建立基线")

        model.recordContextUsage(ContextUsage(tokens: 10_727, contextWindow: 200_000, percent: 5.4))
        XCTAssertEqual(model.contextDelta.added, 727)
        XCTAssertEqual(model.contextDelta.released, 0)

        model.recordContextUsage(ContextUsage(tokens: 10_656, contextWindow: 200_000, percent: 5.3))
        XCTAssertEqual(model.contextDelta.added, 727)
        XCTAssertEqual(model.contextDelta.released, 71)
    }

    // MARK: - 渲染冒烟

    func testActivePlanViewRendersContractAndPauseState() throws {
        let plan = try XCTUnwrap(ActivePlanParser.parse(JSONValue.jsonObject("""
        {"id":"goal-1","objective":"渲染带保障档位的计划","status":"paused",
         "pauseReason":"user_abort",
         "workList":{"items":[{"id":"i1","subject":"工作项","status":"done","evidence":"e2e"}],"phases":[]},
         "contract":{"profile":"execution","transitions":[],"acceptanceCriteria":[]}}
        """)))

        let host = NSHostingView(
            rootView: ActivePlanView(plan: plan, changes: nil, isRunning: false)
                .frame(width: 480, height: 120)
        )
        host.layoutSubtreeIfNeeded()

        XCTAssertFalse(host.fittingSize == .zero)
    }

    func testComposerRendersPlanProposalApprovalCard() {
        let model = AppModel()
        model.selectedSessionID = "session-render"
        model.pendingPlanProposal = PlanProposalPresentation(
            goalID: "goal-1",
            objective: "升级到阶段审核",
            description: nil,
            profile: .stagedCheck,
            verification: "npm test",
            acceptanceCriteria: [
                PlanCriterionPresentation(criterion: "真实手测", evidence: nil),
            ],
            phaseSubjects: ["实现", "验证"],
            nonGoals: []
        )

        let host = NSHostingView(
            rootView: ComposerView().environment(model).frame(width: 900, height: 240)
        )
        host.layoutSubtreeIfNeeded()

        XCTAssertFalse(host.fittingSize == .zero)
    }
}

private extension JSONValue {
    static func jsonObject(_ text: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }
}
