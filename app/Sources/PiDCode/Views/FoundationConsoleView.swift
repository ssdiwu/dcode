import AppKit
import SwiftUI

struct FoundationConsoleView: View {
    @Environment(AppModel.self) private var model
    @State private var selectedTaskID: String?
    @State private var selectedSessionID: String?
    @State private var selectedSessionRunID: String?
    @State private var taskSheetPresented = false
    @State private var projectSheetPresented = false
    @State private var editingProfile: FoundationAgentProfile?
    @State private var previewCandidate: FoundationPiImportCandidate?
    @State private var profileSheetPresented = false
    @State private var selectedTeamProfileIDs: Set<String> = ["builtin-explore", "builtin-verifier"]

    var body: some View {
        HStack(spacing: 0) {
            navigation
                .frame(width: 300)
            Divider()
            detail
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .sheet(isPresented: $taskSheetPresented) {
            FoundationTaskCreateSheet()
        }
        .sheet(isPresented: $projectSheetPresented) {
            FoundationProjectCreateSheet()
        }
        .sheet(item: $editingProfile) { profile in
            FoundationProfileEditor(profile: profile)
        }
        .sheet(isPresented: $profileSheetPresented) {
            FoundationProfileCreateSheet()
        }
        .sheet(item: $previewCandidate, onDismiss: {
            model.clearFoundationPiImportPreview()
        }) { candidate in
            FoundationPiImportPreviewSheet(candidate: candidate)
        }
        .alert(
            model.issue?.title ?? "",
            isPresented: Binding(
                get: { model.issue != nil },
                set: { if !$0 { model.issue = nil } }
            ),
            presenting: model.issue
        ) { _ in
            Button("好", role: .cancel) { model.issue = nil }
        } message: { issue in
            Text(issue.message)
        }
        .task {
            if selectedTaskID == nil { selectedTaskID = snapshot?.tasks.first?.id }
        }
        .onChange(of: snapshot?.tasks.map(\.id)) { _, ids in
            guard let ids else { return }
            if let selectedTaskID, ids.contains(selectedTaskID) { return }
            self.selectedTaskID = ids.first
        }
        .onChange(of: selectedTaskID) { _, _ in
            selectedSessionID = nil
            selectedSessionRunID = nil
        }
    }

    private var snapshot: FoundationSnapshot? { model.foundationSnapshot }

    private var navigation: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("D Code")
                        .font(.headline)
                    Text("0.0.28 · Foundation Console")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    Task { await model.reloadFoundation() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .disabled(model.isLoadingFoundation)
                .help("刷新 Product Store")
            }
            .padding(16)

            Button {
                taskSheetPresented = true
            } label: {
                Label("新建任务", systemImage: "plus.circle.fill")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .frame(height: 38)
            }
            .buttonStyle(.plain)
            .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 9))
            .padding(.horizontal, 12)
            .padding(.bottom, 10)

            Button {
                projectSheetPresented = true
            } label: {
                Label("新建项目", systemImage: "folder.badge.plus")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .frame(height: 34)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 12)
            .padding(.bottom, 8)

            List(selection: $selectedTaskID) {
                if let snapshot {
                    Section("用户空间") {
                        ForEach(snapshot.tasks.filter { task in
                            if case .user = task.scope { return true }
                            return false
                        }) { task in
                            taskRow(task).tag(task.id)
                        }
                    }
                    ForEach(snapshot.projects) { project in
                        Section(project.title) {
                            ForEach(snapshot.tasks.filter { task in
                                task.scope == .project(projectId: project.id)
                            }) { task in
                                taskRow(task).tag(task.id)
                            }
                        }
                    }
                }
            }
            .listStyle(.sidebar)

            if let snapshot {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Product Store")
                        .font(.caption.weight(.semibold))
                    Text(snapshot.dataRoot)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Text("Schema \(snapshot.schemaVersion) · Revision \(snapshot.storeRevision)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
            }
        }
        .background(.ultraThinMaterial)
    }

    private func taskRow(_ task: FoundationTask) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "checklist")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(task.title).lineLimit(1)
                Text(task.state)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
        }
        .padding(.vertical, 3)
    }

    @ViewBuilder
    private var detail: some View {
        if let snapshot, let task = snapshot.tasks.first(where: { $0.id == selectedTaskID }) {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    taskHeader(task, snapshot: snapshot)
                    taskSessions(task, snapshot: snapshot)
                    taskExecutionFacts(task, snapshot: snapshot)
                    taskOutputs(task, snapshot: snapshot)
                    agentProfiles(snapshot)
                    piImport(snapshot)
                }
                .frame(maxWidth: 920, alignment: .leading)
                .padding(32)
                .frame(maxWidth: .infinity, alignment: .top)
            }
        } else if let snapshot {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    ContentUnavailableView(
                        "还没有任务",
                        systemImage: "checklist",
                        description: Text("创建 User Scope 或 Project Scope 任务，或显式导入一个 Pi 会话。")
                    )
                    agentProfiles(snapshot)
                    piImport(snapshot)
                }
                .frame(maxWidth: 920)
                .padding(32)
                .frame(maxWidth: .infinity)
            }
        } else {
            ProgressView("正在打开 Product Store…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func taskHeader(_ task: FoundationTask, snapshot: FoundationSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(task.title)
                    .font(.largeTitle.weight(.semibold))
                Spacer()
                Text(task.state)
                    .font(.caption.monospaced())
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(.quaternary, in: Capsule())
            }
            Text(task.goal)
                .font(.title3)
                .foregroundStyle(.secondary)
            HStack(spacing: 14) {
                Label(scopeLabel(task.scope, snapshot: snapshot), systemImage: "folder")
                Label(task.cwd, systemImage: "terminal")
                    .lineLimit(1)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    private func taskSessions(_ task: FoundationTask, snapshot: FoundationSnapshot) -> some View {
        let sessions = snapshot.sessions.filter { $0.taskId == task.id }
        let observedSession = sessions.first(where: { $0.id == selectedSessionID }) ?? sessions.first
        let observedRuns = snapshot.sessionRuns.filter { $0.sessionId == observedSession?.id }
        let observedRun = observedRuns.first(where: { $0.id == selectedSessionRunID }) ?? observedRuns.last
        let team = snapshot.teamRuns.last(where: { $0.taskId == task.id })
        let agents = snapshot.agentRuns.filter { $0.taskId == task.id && $0.teamRunId == team?.id }
        let requests = snapshot.agentRequests.filter {
            $0.taskId == task.id && $0.teamRunId == team?.id && $0.status == "open"
        }
        let reports = snapshot.agentReports.filter { $0.taskId == task.id }
        return FoundationSection(title: "会话与协调者", subtitle: "一个 Task 可以拥有多个 D Code Session；当前主会话不会等同于 Task 本身。") {
            VStack(alignment: .leading, spacing: 0) {
                if !sessions.isEmpty {
                    HStack {
                        Picker("观察会话", selection: Binding(
                            get: { observedSession?.id },
                            set: {
                                selectedSessionID = $0
                                selectedSessionRunID = nil
                            }
                        )) {
                            ForEach(sessions) { session in
                                Text(session.title).tag(Optional(session.id))
                            }
                        }
                        .pickerStyle(.menu)
                        if !observedRuns.isEmpty {
                            Picker("Session Run", selection: Binding(
                                get: { observedRun?.id },
                                set: { selectedSessionRunID = $0 }
                            )) {
                                ForEach(observedRuns) { run in
                                    Text("\(run.status) · \(run.runtimeId)").tag(Optional(run.id))
                                }
                            }
                            .pickerStyle(.menu)
                        }
                    }
                    if let observedSession {
                        let paths = snapshot.sessionPaths.filter { $0.sessionId == observedSession.id }
                        HStack(spacing: 12) {
                            Label("\(paths.count) Paths", systemImage: "arrow.triangle.branch")
                            if let observedRun {
                                Label(observedRun.status, systemImage: "waveform.path.ecg")
                                Text(observedRun.runtimeId).font(.caption2.monospaced())
                            }
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.bottom, 8)
                    }
                }
                ForEach(sessions) { session in
                    HStack(spacing: 12) {
                        Image(systemName: session.kind == "coordination" ? "person.2.wave.2" : "bubble.left.and.bubble.right")
                            .frame(width: 24)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(session.title)
                            Text("\(session.kind) · lineage \(session.lineageStatus) · \(session.state)")
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text("\(snapshot.sessionPaths.filter { $0.sessionId == session.id }.count) paths")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.tertiary)
                    }
                    .padding(12)
                    if session.id != sessions.last?.id { Divider() }
                }
                Divider().padding(.vertical, 8)
                if let team {
                    HStack {
                        Label("Agent Team · \(team.status)", systemImage: "person.3.fill")
                            .font(.headline)
                        Spacer()
                        Text("\(agents.count) runs")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                        if !agents.isEmpty && agents.allSatisfy({ $0.status == "prepared" }) {
                            Button("启动 Team") {
                                Task { _ = await model.startFoundationTeam(task: task, teamRunId: team.id) }
                            }
                        }
                        if team.status == "completed" && task.state == "active" {
                            Button("拒绝结果", role: .destructive) {
                                Task { _ = await model.decideFoundationTask(task, accepted: false) }
                            }
                            Button("接受 Task") {
                                Task { _ = await model.decideFoundationTask(task, accepted: true) }
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    }
                    ForEach(agents) { agent in
                        HStack(spacing: 9) {
                            Circle()
                                .fill(agent.status == "running" ? Color.green : Color.secondary)
                                .frame(width: 7, height: 7)
                            Text(agent.role)
                            Spacer()
                            Text(agent.status)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                            if ["running", "waiting"].contains(agent.status) {
                                Button("停止") {
                                    Task { await model.stopFoundationAgentRun(agent) }
                                }
                                .buttonStyle(.borderless)
                            }
                        }
                        .padding(.top, 8)
                    }
                    if !requests.isEmpty {
                        Divider().padding(.vertical, 8)
                        Text("等待你的决定").font(.subheadline.weight(.semibold))
                        ForEach(requests) { request in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(request.prompt)
                                VStack(alignment: .leading, spacing: 6) {
                                    ForEach(request.options) { option in
                                        Button {
                                            Task { _ = await model.answerFoundationAgentRequest(request, option: option) }
                                        } label: {
                                            HStack(spacing: 5) {
                                                Text(option.label)
                                                if option.recommended {
                                                    Text("推荐")
                                                        .font(.caption2)
                                                        .foregroundStyle(.secondary)
                                                }
                                            }
                                        }
                                        .help(option.description ?? option.label)
                                    }
                                }
                            }
                            .padding(10)
                            .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 9))
                        }
                    }
                    if !reports.isEmpty {
                        Divider().padding(.vertical, 8)
                        Text("Agent Reports").font(.subheadline.weight(.semibold))
                        ForEach(reports) { report in
                            Text(report.body["text"]?.stringValue ?? "结构化报告已记录")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(4)
                                .padding(.top, 4)
                        }
                    }
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("选择至少两个成员 Profile")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        ForEach(snapshot.agentProfiles.filter {
                            $0.enabled && !["coordinator", "worker"].contains($0.role)
                        }) { profile in
                            Toggle(isOn: Binding(
                                get: { selectedTeamProfileIDs.contains(profile.id) },
                                set: { selected in
                                    if selected { selectedTeamProfileIDs.insert(profile.id) }
                                    else { selectedTeamProfileIDs.remove(profile.id) }
                                }
                            )) {
                                Text("\(profile.name) · \(profile.role)")
                            }
                        }
                        HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("尚未建立 Agent Team").font(.headline)
                            Text("Coordinator 会先规划，再并行派发成员，最后综合真实报告。")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("建立 Agent Team") {
                            Task {
                                _ = await model.createFoundationTeam(
                                    taskId: task.id,
                                    memberProfileIDs: selectedTeamProfileIDs.sorted()
                                )
                            }
                        }
                        .disabled(selectedTeamProfileIDs.count < 2)
                        }
                    }
                }
            }
        }
    }

    private func taskExecutionFacts(_ task: FoundationTask, snapshot: FoundationSnapshot) -> some View {
        let runs = snapshot.sessionRuns.filter { $0.taskId == task.id }
        let attempts = snapshot.operationAttempts.filter { $0.taskId == task.id }
        let uncertain = attempts.filter { ["prepared", "unknown"].contains($0.status) }
        let latestRun = runs.last
        let environment = latestRun?.runtimeEnvironmentId.flatMap { id in
            snapshot.runtimeEnvironments.first(where: { $0.id == id })
        }
        let toolSet = latestRun?.activeToolSetId.flatMap { id in
            snapshot.activeToolSets.first(where: { $0.id == id })
        }
        let receipt = latestRun.flatMap { run in
            snapshot.promptReceipts.first(where: { $0.sessionRunId == run.id })
        }
        return FoundationSection(
            title: "运行事实",
            subtitle: "Attempt 是执行前写下的意图。unknown 表示操作可能已经发生，D Code 不会自动重放。"
        ) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 16) {
                    Label("\(runs.count) Session Runs", systemImage: "waveform.path.ecg")
                    Label("\(attempts.count) Attempts", systemImage: "checklist.checked")
                    if !uncertain.isEmpty {
                        Label("\(uncertain.count) 待核对", systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                }
                .font(.caption)
                if let environment, let toolSet, let receipt {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Agent Environment").font(.subheadline.weight(.semibold))
                        Text("\(environment.modelProvider ?? "unknown")/\(environment.modelId ?? "unknown") · \(environment.workspaceAccess)")
                        Text(environment.cwd).lineLimit(1)
                        Text("\(toolSet.tools.arrayValue?.count ?? 0) tools · \(toolSet.writable ? "writable" : "read-only") · revision \(toolSet.revision)")
                        Text("Prompt \(receipt.systemPromptDigest) · \(receipt.roleRevision)")
                            .font(.caption2.monospaced())
                            .lineLimit(1)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(8)
                    .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
                }
                if attempts.isEmpty {
                    Text("尚无 Provider 或工具执行记录")
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 6)
                } else {
                    ForEach(attempts.reversed()) { attempt in
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: attempt.status == "unknown" ? "questionmark.diamond.fill" : "circle.fill")
                                .font(.caption2)
                                .foregroundStyle(attempt.status == "unknown" ? Color.orange : Color.secondary)
                                .frame(width: 18)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(attempt.operationKind)
                                Text(attempt.targetIdentity)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                Text("replay \(attempt.replayPolicy) · \(attempt.preparedAt)")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                            Spacer()
                            Text(attempt.status)
                                .font(.caption2.monospaced())
                                .foregroundStyle(attempt.status == "unknown" ? .orange : .secondary)
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
        }
    }

    private func agentProfiles(_ snapshot: FoundationSnapshot) -> some View {
        FoundationSection(title: "Agent Profiles", subtitle: "Profile 是可编辑角色档案；真正参与某个 Task 的成员会在运行开始后单独出现。") {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Spacer()
                    Button("创建 Profile") { profileSheetPresented = true }
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 210), spacing: 10)], spacing: 10) {
                ForEach(snapshot.agentProfiles) { profile in
                    Button { editingProfile = profile } label: {
                        VStack(alignment: .leading, spacing: 7) {
                            HStack {
                                Text(profile.name).font(.headline)
                                Spacer()
                                Circle()
                                    .fill(profile.enabled ? Color.green : Color.secondary)
                                    .frame(width: 7, height: 7)
                            }
                            Text(profile.role)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                            Text(profile.roleContract)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(3)
                        }
                        .frame(maxWidth: .infinity, minHeight: 100, alignment: .topLeading)
                        .padding(12)
                        .background(.quaternary.opacity(0.55), in: RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                }
                }
            }
        }
    }

    private func taskOutputs(_ task: FoundationTask, snapshot: FoundationSnapshot) -> some View {
        let reports = snapshot.agentReports.filter { $0.taskId == task.id }
        let artifacts = snapshot.artifacts.filter { $0.taskId == task.id }
        let evidence = snapshot.evidence.filter { $0.taskId == task.id }
        let findings = snapshot.findings.filter { $0.taskId == task.id }
        return FoundationSection(
            title: "报告与交付事实",
            subtitle: "Report、Artifact、Evidence 与 Finding 都来自 Product Store；聊天文案不会被猜成进度。"
        ) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 16) {
                    Label("\(reports.count) Reports", systemImage: "doc.text")
                    Label("\(artifacts.count) Artifacts", systemImage: "shippingbox")
                    Label("\(evidence.count) Evidence", systemImage: "checkmark.seal")
                    Label("\(findings.count) Findings", systemImage: "magnifyingglass")
                }
                .font(.caption)
                if reports.isEmpty && artifacts.isEmpty && evidence.isEmpty && findings.isEmpty {
                    Text("尚无结构化交付事实")
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 6)
                }
                ForEach(findings) { finding in
                    Label(finding.body, systemImage: finding.severity == "blocking" ? "exclamationmark.octagon" : "lightbulb")
                        .foregroundStyle(finding.severity == "blocking" ? Color.red : Color.primary)
                }
                ForEach(artifacts) { artifact in
                    VStack(alignment: .leading, spacing: 2) {
                        Label(artifact.title, systemImage: "shippingbox")
                        Text(artifact.managedPath ?? artifact.externalPath ?? artifact.digest ?? artifact.kind)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                    }
                }
                ForEach(evidence.suffix(20)) { item in
                    HStack {
                        Label(item.commandRedacted ?? item.evidenceKind, systemImage: "checkmark.seal")
                        Spacer()
                        Text(item.exitKind ?? "unknown")
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func piImport(_ snapshot: FoundationSnapshot) -> some View {
        FoundationSection(title: "从 Pi 导入为任务", subtitle: "只有点击导入才会进入 D Code；源 JSONL 保持不变，历史 lineage 标记为 unknown。") {
            if model.foundationImportCandidates.isEmpty {
                Text("没有可导入的外部 Pi 会话")
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 8)
            } else {
                VStack(spacing: 0) {
                    ForEach(model.foundationImportCandidates) { candidate in
                        HStack(spacing: 12) {
                            Image(systemName: "square.and.arrow.down")
                                .frame(width: 24)
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 6) {
                                    Text(candidate.title).lineLimit(1)
                                    if candidate.previouslyImported {
                                        Text("曾导入")
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Text("\(candidate.messageCount) messages · \(candidate.cwd)")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            Button(candidate.previouslyImported ? "查看记录" : "预览并导入") {
                                previewCandidate = candidate
                            }
                        }
                        .padding(12)
                        if candidate.id != model.foundationImportCandidates.last?.id { Divider() }
                    }
                }
            }
        }
    }

    private func scopeLabel(_ scope: FoundationTaskScope, snapshot: FoundationSnapshot) -> String {
        switch scope {
        case .user:
            "用户空间"
        case let .project(projectId):
            snapshot.projects.first(where: { $0.id == projectId })?.title ?? "项目"
        }
    }
}

private struct FoundationProfileCreateSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var roleContract = ""
    @State private var isSaving = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("创建 Agent Profile").font(.title2.weight(.semibold))
            Text("Profile 定义角色，不会自动加入任何 Task。")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("名称", text: $name)
            TextEditor(text: $roleContract)
                .frame(minHeight: 150)
                .overlay { RoundedRectangle(cornerRadius: 8).stroke(.separator) }
            HStack {
                Spacer()
                Button("取消") { dismiss() }
                Button("创建") {
                    isSaving = true
                    Task {
                        if await model.createFoundationAgentProfile(name: name, roleContract: roleContract) { dismiss() }
                        isSaving = false
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || roleContract.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || isSaving)
            }
        }
        .padding(24)
        .frame(width: 540)
    }
}

private struct FoundationProjectCreateSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var directory = ""
    @State private var isSaving = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("新建项目").font(.title2.weight(.semibold))
            Text("一个 Project 对应一个真实目录；项目文档仍留在该目录中。")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("项目名称", text: $title)
            HStack {
                TextField("项目目录", text: $directory)
                Button("选择文件夹") {
                    let panel = NSOpenPanel()
                    panel.canChooseDirectories = true
                    panel.canChooseFiles = false
                    panel.allowsMultipleSelection = false
                    if panel.runModal() == .OK, let url = panel.url {
                        directory = url.path
                        if title.isEmpty { title = url.lastPathComponent }
                    }
                }
            }
            HStack {
                Spacer()
                Button("取消") { dismiss() }
                Button("创建") {
                    isSaving = true
                    Task {
                        if await model.createFoundationProject(title: title, directory: directory) { dismiss() }
                        isSaving = false
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || directory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || isSaving)
            }
        }
        .padding(24)
        .frame(width: 560)
    }
}

private struct FoundationPiImportPreviewSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let candidate: FoundationPiImportCandidate
    @State private var scopeKey = "user"
    @State private var isImporting = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("从 Pi 导入为任务").font(.title2.weight(.semibold))
            Text(candidate.title).font(.headline)
            if let preview = model.foundationImportPreview,
               preview.sourceSessionId == candidate.sourceSessionId {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 8) {
                    GridRow { Text("Lineage"); Text(preview.lineageStatus) }
                    GridRow { Text("可导入记录"); Text("\(preview.importedEntryCount)") }
                    GridRow { Text("Source digest"); Text(preview.sourceDigest).font(.caption.monospaced()) }
                    GridRow { Text("源文件"); Text(preview.sourcePath).lineLimit(2) }
                }
                .font(.caption)
                let omissions = [
                    preview.omittedContent.hiddenThinking ? "隐藏 Thinking" : nil,
                    preview.omittedContent.binaryImages ? "图片二进制" : nil,
                    preview.omittedContent.toolArguments ? "工具参数" : nil,
                    preview.omittedContent.toolResults ? "工具结果正文" : nil,
                    preview.omittedContent.redactedSecrets ? "疑似凭据" : nil,
                ].compactMap { $0 }
                Text(omissions.isEmpty ? "没有检测到需要省略的内容。" : "导入时省略：\(omissions.joined(separator: "、"))")
                    .font(.caption)
                    .foregroundStyle(omissions.isEmpty ? Color.secondary : Color.orange)
                Picker("归属", selection: $scopeKey) {
                    Text("用户空间").tag("user")
                    ForEach(model.foundationSnapshot?.projects ?? []) { project in
                        Text(project.title).tag("project:\(project.id)")
                    }
                }
                HStack {
                    Spacer()
                    Button("取消") { dismiss() }
                    Button("导入为任务") {
                        guard let snapshot = model.foundationSnapshot else { return }
                        isImporting = true
                        let scope: FoundationTaskScope = scopeKey.hasPrefix("project:")
                            ? .project(projectId: String(scopeKey.dropFirst("project:".count)))
                            : .user(userId: snapshot.currentUser.id)
                        Task {
                            if await model.importPiSessionAsFoundationTask(
                                sourceSessionId: candidate.sourceSessionId,
                                scope: scope
                            ) { dismiss() }
                            isImporting = false
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(candidate.previouslyImported || isImporting)
                }
            } else {
                ProgressView("正在核对源会话…")
            }
        }
        .padding(24)
        .frame(width: 620)
        .task { _ = await model.previewFoundationPiSession(sourceSessionId: candidate.sourceSessionId) }
    }
}

private struct FoundationSection<Content: View>: View {
    let title: String
    let subtitle: String
    private let content: Content

    init(title: String, subtitle: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.title2.weight(.semibold))
            Text(subtitle).font(.caption).foregroundStyle(.secondary)
            content
                .padding(10)
                .background(.background, in: RoundedRectangle(cornerRadius: 12))
                .overlay {
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(Color(nsColor: .separatorColor).opacity(0.55))
                }
        }
    }
}

private struct FoundationTaskCreateSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var goal = ""
    @State private var scopeKey = "user"
    @State private var isSaving = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("新建任务").font(.title2.weight(.semibold))
            TextField("任务名称", text: $title)
            TextField("这次任务要完成什么？", text: $goal, axis: .vertical)
                .lineLimit(3...6)
            Picker("归属", selection: $scopeKey) {
                Text("用户空间").tag("user")
                ForEach(model.foundationSnapshot?.projects ?? []) { project in
                    Text(project.title).tag("project:\(project.id)")
                }
            }
            HStack {
                Spacer()
                Button("取消") { dismiss() }
                Button("创建") {
                    guard let snapshot = model.foundationSnapshot else { return }
                    isSaving = true
                    let scope: FoundationTaskScope = scopeKey.hasPrefix("project:")
                        ? .project(projectId: String(scopeKey.dropFirst("project:".count)))
                        : .user(userId: snapshot.currentUser.id)
                    Task {
                        if await model.createFoundationTask(title: title, goal: goal, scope: scope) { dismiss() }
                        isSaving = false
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || isSaving)
            }
        }
        .padding(24)
        .frame(width: 480)
    }
}

private struct FoundationProfileEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let profile: FoundationAgentProfile
    @State private var name: String
    @State private var roleContract: String
    @State private var enabled: Bool
    @State private var isSaving = false

    init(profile: FoundationAgentProfile) {
        self.profile = profile
        _name = State(initialValue: profile.name)
        _roleContract = State(initialValue: profile.roleContract)
        _enabled = State(initialValue: profile.enabled)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("编辑 Agent Profile").font(.title2.weight(.semibold))
            Text(profile.role).font(.caption.monospaced()).foregroundStyle(.secondary)
            TextField("名称", text: $name)
            TextEditor(text: $roleContract)
                .font(.body)
                .frame(minHeight: 150)
                .overlay { RoundedRectangle(cornerRadius: 8).stroke(.separator) }
            Toggle("启用这个 Profile", isOn: $enabled)
            HStack {
                Spacer()
                Button("取消") { dismiss() }
                Button("保存") {
                    isSaving = true
                    Task {
                        if await model.updateFoundationAgentProfile(
                            profile,
                            name: name,
                            roleContract: roleContract,
                            enabled: enabled
                        ) { dismiss() }
                        isSaving = false
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || roleContract.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || isSaving)
            }
        }
        .padding(24)
        .frame(width: 560)
    }
}
