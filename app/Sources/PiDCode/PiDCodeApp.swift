import AppKit
import SwiftUI
@preconcurrency import UserNotifications

private final class ShutdownCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var completed = false

    var isCompleted: Bool { lock.withLock { completed } }

    func markCompleted() {
        lock.withLock { completed = true }
    }
}

@MainActor
final class PiDCodeAppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    static weak var model: AppModel?
    private static var pendingCompletionResponses: [[AnyHashable: Any]] = []
    private static let shutdownTimeoutSeconds: TimeInterval = 4
    private var terminationInFlight = false

    func applicationWillFinishLaunching(_ notification: Notification) {
        let stored = UserDefaults.standard.string(forKey: AppAppearance.storageKey)
        AppAppearance.resolve(stored ?? AppAppearance.system.rawValue).apply()
        UNUserNotificationCenter.current().delegate = self
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        guard UserDefaults.standard.bool(forKey: CompletionNotificationSettings.enabledStorageKey) else {
            completionHandler([])
            return
        }
        completionHandler([.banner, .sound])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        completionHandler()
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
        Task { @MainActor in
            NSApplication.shared.activate(ignoringOtherApps: true)
            await Self.routeCompletionNotificationResponse(userInfo)
        }
    }

    static func installModel(_ model: AppModel) {
        self.model = model
        let pending = pendingCompletionResponses
        pendingCompletionResponses.removeAll()
        guard !pending.isEmpty else { return }
        Task { @MainActor in
            for userInfo in pending {
                await model.handleCompletionNotificationResponse(userInfo)
            }
        }
    }

    static func routeCompletionNotificationResponse(_ userInfo: [AnyHashable: Any]) async {
        guard let model else {
            pendingCompletionResponses.append(userInfo)
            if pendingCompletionResponses.count > 20 {
                pendingCompletionResponses.removeFirst(pendingCompletionResponses.count - 20)
            }
            return
        }
        await model.handleCompletionNotificationResponse(userInfo)
    }

    static func resetCompletionNotificationRoutingForTests() {
        model = nil
        pendingCompletionResponses.removeAll()
    }

    func applicationWillTerminate(_ notification: Notification) {
        Self.model?.emergencyStop()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let model = Self.model else { return .terminateNow }
        if terminationInFlight {
            // 第二次 Quit 不能再交给一个已经没有 reply 路径的 terminateLater；
            // 先结束当前 App 所拥有的 Host，再允许 AppKit 完成退出。
            model.emergencyStop()
            return .terminateNow
        }
        terminationInFlight = true
        Task { @MainActor [weak self] in
            let completion = ShutdownCompletion()
            let shutdownTask = Task { @MainActor in
                await model.shutdown()
                completion.markCompleted()
            }
            let deadline = Date().timeIntervalSinceReferenceDate + Self.shutdownTimeoutSeconds
            while !completion.isCompleted,
                  Date().timeIntervalSinceReferenceDate < deadline {
                try? await Task.sleep(for: .milliseconds(50))
            }
            if !completion.isCompleted {
                shutdownTask.cancel()
                model.emergencyStop()
            } else {
                await shutdownTask.value
            }
            sender.reply(toApplicationShouldTerminate: true)
            self?.terminationInFlight = false
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
                    await model.start()
                    PiDCodeAppDelegate.installModel(model)
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
