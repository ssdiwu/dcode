import SwiftUI

/// 自定义模型供应商（0.0.16，Pi models.json 合同）：脱敏列表 + 编辑表单。
/// 凭据只写不回显（正文永不进入 D Code）；字段级错误来自 Host 的
/// 结构检查与 Pi `ModelConfig` 真实校验，非法输入零写入。
struct CustomProvidersSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var editingProvider: ModelProviderView?
    @State private var creatingProvider = false
    @State private var pendingRemoval: ModelProviderView?

    var body: some View {
        SettingsPageContainer(
            title: "自定义供应商",
            subtitle: "经 Pi 的 models.json 合同管理自定义供应商与模型定义；认证正文只写不回显，保存前由 Pi 真实校验。"
        ) {
            VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingSection) {
                if let parseError = model.modelProviders.snapshot?.parseError {
                    SettingsGroup {
                        VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingGroup) {
                            Label("models.json 当前无法解析，编辑已被拒绝", systemImage: "exclamationmark.triangle.fill")
                                .font(.callout.weight(.semibold))
                                .foregroundStyle(.orange)
                            Text(parseError)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                        .padding(20)
                    }
                }
                if model.modelProviders.isLoading && model.modelProviders.snapshot == nil {
                    SettingsGroup {
                        HStack(spacing: PiDCodeMetrics.spacingGroup) {
                            ProgressView().controlSize(.small)
                            Text("正在读取自定义供应商…").foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 20)
                        .frame(minHeight: 60, alignment: .leading)
                    }
                } else if let issue = model.modelProviders.issue, model.modelProviders.snapshot == nil {
                    SettingsGroup {
                        VStack(alignment: .leading, spacing: PiDCodeMetrics.spacingGroup) {
                            Text(issue).foregroundStyle(.secondary)
                            Button("重试") {
                                Task { await model.loadModelProviders() }
                            }
                        }
                        .padding(20)
                    }
                } else if let snapshot = model.modelProviders.snapshot {
                    providerList(snapshot.providers)
                    Button {
                        creatingProvider = true
                    } label: {
                        Label("新建供应商", systemImage: "plus")
                            .frame(minWidth: 120, minHeight: PiDCodeMetrics.compactControlHeight)
                    }
                    .buttonStyle(.bordered)
                    Text("新目录在 Pi 重新加载后生效；运行中的会话在新打开或刷新模型目录后可见。文件：\(snapshot.path)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, PiDCodeMetrics.spacingTight)
                }
            }
        }
        .task {
            await model.loadModelProviders()
        }
        .sheet(isPresented: $creatingProvider) {
            ProviderEditorSheet(provider: nil)
        }
        .sheet(item: $editingProvider) { provider in
            ProviderEditorSheet(provider: provider)
        }
        .confirmationDialog(
            "删除自定义供应商“\(pendingRemoval?.id ?? "")”？",
            isPresented: Binding(
                get: { pendingRemoval != nil },
                set: { if !$0 { pendingRemoval = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("删除", role: .destructive) {
                guard let provider = pendingRemoval else { return }
                pendingRemoval = nil
                Task { await model.removeModelProvider(id: provider.id) }
            }
            Button("取消", role: .cancel) { pendingRemoval = nil }
        } message: {
            Text("只删除 models.json 中的该供应商定义；Pi 凭据与其他供应商不受影响。")
        }
    }

    private func providerList(_ providers: [ModelProviderView]) -> some View {
        SettingsGroup {
            if providers.isEmpty {
                Text("还没有自定义供应商。")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 20)
                    .frame(minHeight: 60, alignment: .leading)
            } else {
                ForEach(providers) { provider in
                    if provider.id != providers.first?.id {
                        Divider().padding(.leading, 20)
                    }
                    HStack(spacing: PiDCodeMetrics.spacingGroup) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(provider.name ?? provider.id)
                                .font(.body.weight(.medium))
                            HStack(spacing: 8) {
                                Text(provider.id)
                                    .font(.caption.monospaced())
                                Text("·")
                                Text(provider.authLabel)
                                    .font(.caption)
                                    .foregroundStyle(provider.authConfigured ? Color.secondary : Color.orange)
                                Text("·")
                                Text("\(provider.models.count) 模型")
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                            .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: PiDCodeMetrics.spacingGroup)
                        Button("编辑") {
                            editingProvider = provider
                        }
                        .controlSize(.small)
                        Button("删除", role: .destructive) {
                            pendingRemoval = provider
                        }
                        .controlSize(.small)
                    }
                    .padding(.horizontal, 20)
                    .frame(minHeight: 56, alignment: .leading)
                }
            }
        }
    }
}

/// 编辑表单：新建（provider == nil）或修改既有供应商。
private struct ProviderEditorSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    let provider: ModelProviderView?

    @State private var id = ""
    @State private var name = ""
    @State private var baseUrl = ""
    @State private var api = ""
    @State private var apiKeyInput = ""
    @State private var clearAuth = false
    @State private var useOAuth = false
    @State private var models: [ModelProviderModelInput] = []
    @State private var compatJson = ""
    @State private var fieldErrors: [ProviderFieldError] = []
    @State private var saving = false

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    basicsSection
                    authSection
                    modelsSection
                    advancedSection
                    if !fieldErrors.isEmpty {
                        errorSummary
                    }
                }
                .padding(20)
                .frame(maxWidth: 620, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            footer
        }
        .frame(width: 640, height: 560)
        .onAppear(perform: populate)
    }

    private var header: some View {
        HStack {
            Text(provider == nil ? "新建自定义供应商" : "编辑 \(provider?.id ?? "")")
                .font(.headline)
            Spacer()
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    private var footer: some View {
        HStack {
            if model.modelProviders.isSaving {
                ProgressView().controlSize(.small)
            }
            Spacer()
            Button("取消") { dismiss() }
                .frame(minHeight: PiDCodeMetrics.compactControlHeight)
            Button("保存", action: save)
                .keyboardShortcut(.defaultAction)
                .frame(minHeight: PiDCodeMetrics.compactControlHeight)
                .disabled(saving || id.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    private var basicsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("基础")
            fieldRow("ID", field: "id") {
                TextField("my-provider", text: $id)
                    .disabled(provider != nil)
                    .help("models.json 中的供应商键；创建后不可修改")
            }
            fieldRow("名称", field: "name") {
                TextField("显示名称", text: $name)
            }
            fieldRow("Base URL", field: "baseUrl") {
                TextField("https://api.example.com/v1", text: $baseUrl)
            }
            fieldRow("API 类型", field: "api") {
                TextField("如 openai-completions（可选）", text: $api)
            }
        }
    }

    private var authSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("认证")
            if let provider {
                HStack(spacing: 8) {
                    Image(systemName: provider.authConfigured ? "lock.fill" : "lock.open")
                        .foregroundStyle(provider.authConfigured ? Color.secondary : Color.orange)
                    Text("当前：\(provider.authLabel)")
                        .font(.callout)
                    if !provider.headerKeys.isEmpty {
                        Text("headers：\(provider.headerKeys.joined(separator: "、"))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            Toggle("使用 OAuth（radius）", isOn: $useOAuth)
                .disabled(clearAuth)
            if !useOAuth {
                fieldRow("API Key（只写，不回显）", field: "apiKey") {
                    SecureField(provider?.authConfigured == true ? "已配置——输入新值即替换" : "未配置", text: $apiKeyInput)
                }
            }
            Toggle("清除已保存的认证", isOn: $clearAuth)
            Text("凭据正文不会显示、复制或导出；既有值由 Host 合并保留。")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var modelsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                sectionTitle("模型定义（\(models.count)）")
                Spacer()
                Button {
                    withAnimation {
                        models.append(ModelProviderModelInput(id: "", name: nil, api: nil, baseUrl: nil, reasoning: nil, contextWindow: nil, maxTokens: nil))
                    }
                } label: {
                    Label("添加模型", systemImage: "plus")
                }
                .controlSize(.small)
            }
            if models.isEmpty {
                Text("该供应商还没有模型定义。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(models.indices, id: \.self) { index in
                modelRow(index)
            }
        }
    }

    private func modelRow(_ index: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            HStack {
                Text("模型 \(index + 1)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button(role: .destructive) {
                    _ = withAnimation { models.remove(at: index) }
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .accessibilityLabel("删除模型 \(index + 1)")
            }
            fieldRow("模型 ID", field: "models[\(index)].id") {
                TextField("model-id", text: stringBinding(index: index, keyPath: \.id))
            }
            fieldRow("名称", field: "models[\(index)].name") {
                TextField("显示名称（可选）", text: optionalStringBinding(index: index, keyPath: \.name))
            }
            HStack(spacing: 16) {
                Toggle("支持推理", isOn: optionalBoolBinding(index: index, keyPath: \.reasoning))
                fieldRow("上下文窗口", field: "models[\(index)].contextWindow") {
                    TextField("如 128000", text: optionalIntBinding(index: index, keyPath: \.contextWindow))
                        .frame(width: 120)
                }
                fieldRow("最大输出", field: "models[\(index)].maxTokens") {
                    TextField("如 16384", text: optionalIntBinding(index: index, keyPath: \.maxTokens))
                        .frame(width: 120)
                }
            }
        }
    }

    private var advancedSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("高级（JSON，可选）")
            fieldRow("compat", field: "compatJson") {
                TextEditor(text: $compatJson)
                    .font(.system(.caption, design: .monospaced))
                    .frame(minHeight: 72)
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .strokeBorder(error(for: "compatJson") != nil ? Color.red.opacity(0.6) : Color.primary.opacity(0.12))
                    )
            }
            Text("留空且未修改时保持既有高级字段；模型的高级字段（thinkingLevelMap、cost 等）与 modelOverrides 在保存时自动保留。")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var errorSummary: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("保存被拒绝（原文件未改动）", systemImage: "xmark.octagon.fill")
                .font(.callout.weight(.semibold))
                .foregroundStyle(.red)
            ForEach(fieldErrors, id: \.field) { error in
                Text("\(error.field)：\(error.message)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .background(Color.red.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - 状态与动作

    private func populate() {
        guard let provider else { return }
        id = provider.id
        name = provider.name ?? ""
        baseUrl = provider.baseUrl ?? ""
        api = provider.api ?? ""
        useOAuth = provider.authMode == "oauth"
        models = provider.models.map { entry in
            ModelProviderModelInput(
                id: entry.id,
                name: entry.name,
                api: entry.api,
                baseUrl: entry.baseUrl,
                reasoning: entry.reasoning,
                contextWindow: entry.contextWindow,
                maxTokens: entry.maxTokens
            )
        }
        compatJson = provider.compatJson ?? ""
    }

    private func save() {
        let trimmedID = id.trimmingCharacters(in: .whitespaces)
        var input = ModelProviderSaveInput(
            id: trimmedID,
            name: name.trimmingCharacters(in: .whitespaces).isEmpty
                ? nil
                : name.trimmingCharacters(in: .whitespaces),
            baseUrl: baseUrl.trimmingCharacters(in: .whitespaces).isEmpty
                ? nil
                : baseUrl.trimmingCharacters(in: .whitespaces),
            api: api.trimmingCharacters(in: .whitespaces).isEmpty
                ? nil
                : api.trimmingCharacters(in: .whitespaces),
            newApiKey: nil,
            oauthRadius: nil,
            removeAuth: nil,
            models: models.map { entry in
                var next = entry
                next.id = entry.id.trimmingCharacters(in: .whitespaces)
                return next
            },
            compatJson: nil
        )
        if clearAuth {
            input.removeAuth = true
        } else if useOAuth {
            input.oauthRadius = true
        } else if !apiKeyInput.isEmpty {
            input.newApiKey = apiKeyInput
        }
        if provider?.compatJson != nil || !compatJson.isEmpty {
            input.compatJson = compatJson.trimmingCharacters(in: .whitespaces)
        }

        fieldErrors = []
        saving = true
        Task {
            let errors = await model.saveModelProvider(input)
            saving = false
            if errors.isEmpty {
                dismiss()
            } else {
                fieldErrors = errors
            }
        }
    }

    // MARK: - 表单辅助

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
    }

    private func error(for field: String) -> String? {
        fieldErrors.first { $0.field == field }?.message
    }

    @ViewBuilder
    private func fieldRow<Control: View>(
        _ label: String,
        field: String,
        @ViewBuilder control: () -> Control
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let message = error(for: field) {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            control()
        }
    }

    private func stringBinding(index: Int, keyPath: WritableKeyPath<ModelProviderModelInput, String>) -> Binding<String> {
        Binding(
            get: { models.indices.contains(index) ? models[index][keyPath: keyPath] : "" },
            set: { if models.indices.contains(index) { models[index][keyPath: keyPath] = $0 } }
        )
    }

    private func optionalStringBinding(index: Int, keyPath: WritableKeyPath<ModelProviderModelInput, String?>) -> Binding<String> {
        Binding(
            get: { models.indices.contains(index) ? (models[index][keyPath: keyPath] ?? "") : "" },
            set: {
                guard models.indices.contains(index) else { return }
                let trimmed = $0.trimmingCharacters(in: .whitespaces)
                models[index][keyPath: keyPath] = trimmed.isEmpty ? nil : trimmed
            }
        )
    }

    private func optionalBoolBinding(index: Int, keyPath: WritableKeyPath<ModelProviderModelInput, Bool?>) -> Binding<Bool> {
        Binding(
            get: { models.indices.contains(index) ? (models[index][keyPath: keyPath] ?? false) : false },
            set: { if models.indices.contains(index) { models[index][keyPath: keyPath] = $0 } }
        )
    }

    private func optionalIntBinding(index: Int, keyPath: WritableKeyPath<ModelProviderModelInput, Int?>) -> Binding<String> {
        Binding(
            get: {
                guard models.indices.contains(index) else { return "" }
                return models[index][keyPath: keyPath].map(String.init) ?? ""
            },
            set: {
                guard models.indices.contains(index) else { return }
                let trimmed = $0.trimmingCharacters(in: .whitespaces)
                models[index][keyPath: keyPath] = trimmed.isEmpty ? nil : Int(trimmed)
            }
        )
    }
}
