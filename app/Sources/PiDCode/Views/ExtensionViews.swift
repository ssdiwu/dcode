import SwiftUI

struct ExtensionDialogView: View {
    @Environment(AppModel.self) private var model
    let dialog: ExtensionDialog
    @State private var value: String
    @State private var selection: String?

    init(dialog: ExtensionDialog) {
        self.dialog = dialog
        _value = State(initialValue: dialog.prefill ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 5) {
                Text(dialog.title)
                    .font(.title2.weight(.semibold))
                if let message = dialog.message, !message.isEmpty {
                    Text(message)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            dialogBody
            HStack {
                Button("取消", role: .cancel) {
                    Task { await model.cancel(dialog) }
                }
                Spacer()
                if dialog.method != .select {
                    Button(primaryLabel) { submit() }
                        .keyboardShortcut(.defaultAction)
                        .disabled(primaryDisabled)
                }
            }
        }
        .padding(24)
        .frame(width: dialog.method == .editor ? 620 : 460)
    }

    @ViewBuilder
    private var dialogBody: some View {
        switch dialog.method {
        case .select:
            ScrollView {
                LazyVStack(spacing: 4) {
                    ForEach(dialog.options, id: \.self) { option in
                        Button {
                            Task { await model.respond(to: dialog, response: ["value": .string(option)]) }
                        } label: {
                            HStack {
                                Text(option).foregroundStyle(.primary)
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.horizontal, 10)
                            .frame(minHeight: PiDCodeMetrics.minimumTarget)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .background(Color.primary.opacity(selection == option ? 0.07 : 0), in: RoundedRectangle(cornerRadius: 7))
                        .onHover { hovering in selection = hovering ? option : nil }
                    }
                }
            }
            .frame(maxHeight: 320)
        case .confirm:
            EmptyView()
        case .input:
            TextField(dialog.placeholder ?? "输入", text: $value)
                .textFieldStyle(.roundedBorder)
        case .editor:
            TextEditor(text: $value)
                .font(.body.monospaced())
                .frame(minHeight: 260)
                .padding(6)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius))
                .overlay {
                    RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius)
                        .strokeBorder(Color.primary.opacity(0.13))
                }
        }
    }

    private var primaryLabel: String {
        dialog.method == .confirm ? "确认" : "提交"
    }

    private var primaryDisabled: Bool {
        (dialog.method == .input || dialog.method == .editor)
            && value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func submit() {
        let response: [String: JSONValue]
        switch dialog.method {
        case .confirm:
            response = ["confirmed": .bool(true)]
        case .input, .editor:
            response = ["value": .string(value)]
        case .select:
            return
        }
        Task { await model.respond(to: dialog, response: response) }
    }
}
