import AppKit
import SwiftUI

@MainActor
final class PiDCodeAppDelegate: NSObject, NSApplicationDelegate {
    static weak var model: AppModel?
    private var terminationInFlight = false

    func applicationWillFinishLaunching(_ notification: Notification) {
        let stored = UserDefaults.standard.string(forKey: AppAppearance.storageKey)
        AppAppearance.resolve(stored ?? AppAppearance.system.rawValue).apply()
    }

    func applicationWillTerminate(_ notification: Notification) {
        Self.model?.emergencyStop()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminationInFlight { return .terminateLater }
        guard let model = Self.model else { return .terminateNow }
        terminationInFlight = true
        Task {
            await model.shutdown()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

@main
struct PiDCodeApp: App {
    @NSApplicationDelegateAdaptor(PiDCodeAppDelegate.self) private var appDelegate
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .frame(minWidth: 640, minHeight: 620)
                .task {
                    PiDCodeAppDelegate.model = model
                    await model.start()
                }
                .onDisappear {
                    Task { await model.shutdown() }
                }
        }
        .defaultSize(width: 1_360, height: 860)
        .windowStyle(.hiddenTitleBar)
        .commands {
            SidebarCommands()
            CommandGroup(replacing: .appSettings) {
                Button("设置…") { model.presentSettings() }
                    .keyboardShortcut(",", modifiers: .command)
            }
            CommandGroup(after: .sidebar) {
                Button("新建会话") {
                    Task { await model.startGlobalSession() }
                }
                .keyboardShortcut("n", modifiers: .command)
                .disabled(
                    !model.canUseHostSessions
                        || model.isCreatingSession
                        || model.isOpeningSession
                        || model.isStreaming
                        || model.isPromptTransactionActive
                )
                Button("搜索会话…") { model.presentSearch() }
                    .keyboardShortcut("k", modifiers: .command)
                    .disabled(
                        !model.canUseHostSessions
                            || model.isOpeningSession
                            || model.isPromptTransactionActive
                    )
            }
        }
    }
}
