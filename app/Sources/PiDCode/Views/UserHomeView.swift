import SwiftUI

struct UserHomeView: View {
    let newSession: () -> Void
    let newProject: () -> Void
    let canCreateSession: Bool
    let canCreateProject: Bool

    var body: some View {
        VStack(spacing: 22) {
            Image(systemName: "terminal.fill")
                .font(.system(size: 42, weight: .semibold))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            VStack(spacing: 8) {
                Text("D Code")
                    .font(.largeTitle.weight(.semibold))
                Text("从最近会话继续，或为一组源文件夹建立项目。")
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                Button("新建会话", action: newSession)
                    .controlSize(.large)
                    .dCodeAccessibleButton("新建会话")
                    .disabled(!canCreateSession)
                Button("新建项目…", action: newProject)
                    .controlSize(.large)
                    .buttonStyle(.borderedProminent)
                    .dCodeAccessibleButton("新建项目")
                    .disabled(!canCreateProject)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}
