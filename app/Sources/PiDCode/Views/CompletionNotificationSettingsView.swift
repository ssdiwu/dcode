import SwiftUI

struct CompletionNotificationSettingsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        SettingsPageContainer(
            title: "通知",
            subtitle: "控制 D Code 是否在任务完成后发送 macOS 系统通知。"
        ) {
            SettingsGroup {
                SettingsValueRow(
                    title: "任务完成时通知我",
                    detail: "只在 Run 已确认完成且拥有稳定完成对象时发送；不会包含回答正文、文件内容或路径。"
                ) {
                    Toggle(
                        "任务完成时通知我",
                        isOn: Binding(
                            get: { model.completionNotificationsEnabled },
                            set: { enabled in
                                Task { await model.setCompletionNotificationsEnabled(enabled) }
                            }
                        )
                    )
                    .labelsHidden()
                }

                Divider().padding(.leading, 20)

                SettingsValueRow(
                    title: "系统权限",
                    detail: authorizationDetail
                ) {
                    Text(model.completionNotificationAuthorizationState.label)
                        .foregroundStyle(authorizationColor)
                }

                if model.completionNotificationAuthorizationState == .denied {
                    Divider().padding(.leading, 20)
                    HStack {
                        Text("macOS 已拒绝 D Code 的通知权限。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("打开系统通知设置") {
                            model.openCompletionNotificationSettings()
                        }
                        .controlSize(.small)
                    }
                }
            }
        }
        .task {
            await model.refreshCompletionNotificationAuthorizationState()
        }
    }

    private var authorizationDetail: String {
        switch model.completionNotificationAuthorizationState {
        case .notDetermined: "首次开启时才会请求提醒与声音权限。"
        case .authorized: "系统允许 D Code 显示提醒与声音。"
        case .denied: "系统已拒绝；请在 macOS 通知设置中重新允许。"
        case .restricted: "当前系统策略限制了通知。"
        }
    }

    private var authorizationColor: Color {
        switch model.completionNotificationAuthorizationState {
        case .authorized: .green
        case .denied, .restricted: .orange
        case .notDetermined: .secondary
        }
    }
}
