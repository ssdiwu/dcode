import Foundation
import Observation

/// 会话与 Plan 事件：生命周期、Run 状态、Prompt 结算、冲突与同步。
extension AppModel {
    func handleSessionHostEvent(_ event: HostEvent) {
        switch event.name {
        case "session.closed":
            resetExtensionUIState()
        case "session.runStateChanged":
            guard let data = event.data,
                  let state = try? data.decoded(SessionRunState.self) else { return }
            applyRunState(state)
        case "session.event":
            handleSessionEvent(event.data)
        case "session.promptCompleted":
            if let sessionID = event.data?["sessionId"]?.stringValue,
               let promptID = event.data?["promptId"]?.stringValue,
               pendingPrompt?.sessionID == sessionID,
               pendingPrompt?.promptID == promptID {
                let outcome = event.data?["outcome"]?.stringValue
                if outcome == "persisted", let entryID = event.data?["entryId"]?.stringValue {
                    if pendingPrompt?.isFollowUpDispatch == true {
                        Task { [weak self] in
                            await self?.confirmFollowUpPromptPersisted(
                                sessionID: sessionID,
                                promptID: promptID,
                                entryID: entryID
                            )
                        }
                    } else {
                        currentSessionRunID = promptID
                        _ = completePersistedPrompt(sessionID: sessionID, promptID: promptID, entryID: entryID)
                    }
                } else if pendingPrompt?.isFollowUpDispatch == true {
                    let queueID = pendingPrompt?.followUpQueueID
                    let itemID = pendingPrompt?.followUpItemID
                    Task { [weak self] in
                        guard let self, let queueID, let itemID else { return }
                        await self.markFollowUpDispatchUnknown(
                            queueID: queueID,
                            itemID: itemID,
                            promptID: promptID
                        )
                        if self.pendingPrompt?.promptID == promptID { self.pendingPrompt = nil }
                        self.showNotice("Host 未返回后续消息的持久化条目；队列已暂停等待核对。", level: "warning")
                    }
                } else if pendingPrompt?.draftTarget?.pathAction != nil {
                    restorePendingPrompt(for: sessionID)
                } else {
                    completeHandledPrompt(sessionID: sessionID, promptID: promptID)
                }
            }
        case "session.promptFailed":
            guard let sessionID = event.data?["sessionId"]?.stringValue,
                  let promptID = event.data?["promptId"]?.stringValue else { return }
            let persistedEntryID = event.data?["persistedEntryId"]?.stringValue
            let message = event.data?["message"]?.stringValue
                ?? (persistedEntryID == nil
                    ? "本次输入未能完成。"
                    : "输入已经进入会话，但对应 Agent 运行失败。")
            if pendingPrompt?.sessionID != sessionID || pendingPrompt?.promptID != promptID {
                guard followUp.queues.contains(where: {
                    $0.sessionID == sessionID && $0.activeRunID == promptID
                }) else { return }
                Task { [weak self] in
                    await self?.failActiveFollowUpRun(
                        sessionID: sessionID,
                        promptID: promptID,
                        persistedEntryID: persistedEntryID,
                        message: message
                    )
                }
                return
            }
            if pendingPrompt?.isFollowUpDispatch == true {
                Task { [weak self] in
                    await self?.failFollowUpPrompt(
                        sessionID: sessionID,
                        promptID: promptID,
                        persistedEntryID: persistedEntryID,
                        message: message
                    )
                }
                return
            }
            if let entryID = event.data?["persistedEntryId"]?.stringValue,
               completePersistedPrompt(sessionID: sessionID, promptID: promptID, entryID: entryID) {
                showNotice("输入已经保存到新路径，但后续 Agent 运行失败。", level: "error")
                return
            }
            restorePendingPrompt(for: sessionID)
            showNotice(event.data?["message"]?.stringValue ?? "本次输入未能完成，草稿仍保留。", level: "error")
        case "session.changeRecorded":
            recordSessionChange(event.data)
        case "session.conflict":
            guard let sessionID = event.data?["sessionId"]?.stringValue else { return }
            cancelFollowUpSettlementGate()
            if pendingPrompt?.sessionID == sessionID, pendingPrompt?.isFollowUpDispatch != true {
                restorePendingPrompt(for: sessionID)
            }
            guard sessionID == selectedSessionID else { return }
            isStreaming = false
            markCurrentRunUnknown()
            let conflictCode = event.data?["code"]?.stringValue
            let stolen = conflictCode == "LEASE_STOLEN"
            sessionConflict = SessionConflictPresentation(
                sessionID: sessionID,
                code: conflictCode,
                isTakeover: stolen
            )
            showNotice(
                stolen
                    ? "写入所有权已被另一个 D Code 窗口接管；草稿已保留。"
                    : "检测到 Pi 的新写入，D Code 已停止写入；草稿已保留，可重新接管。",
                level: "warning"
            )
            Task { [weak self] in
                guard let self else { return }
                await self.pauseFollowUpQueues(sessionID: sessionID, reason: .conflict)
                if self.pendingPrompt?.sessionID == sessionID,
                   self.pendingPrompt?.isFollowUpDispatch == true {
                    self.pendingPrompt = nil
                }
            }
        case "session.changed":
            guard event.data?["sessionId"]?.stringValue == selectedSessionID else { return }
            scheduleRefresh()
        case "session.searchIndexChanged":
            if let value = event.data,
               let next = try? value.decoded(SessionSearchIndexStatus.self) {
                applySearchIndexStatus(next)
            }
        case "session.syncError":
            guard event.data?["sessionId"]?.stringValue == selectedSessionID else { return }
            showNotice("暂时无法同步 Pi 会话：\(event.data?["message"]?.stringValue ?? "未知错误")", level: "warning")
        case "session.operationError", "extension.error":
            showNotice(event.data?["message"]?.stringValue ?? "扩展或会话操作失败。", level: "error")
        case "plan.changed":
            activePlan = ActivePlanParser.parse(event.data?["plan"])
            pendingPlanProposal = ActivePlanParser.parseProposal(event.data?["proposal"])
            scheduleRefresh()
        default:
            break
        }
    }
}
