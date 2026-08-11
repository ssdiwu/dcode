import AppKit
import SwiftUI

@MainActor
final class PiDCodeAppDelegate: NSObject, NSApplicationDelegate {
    static weak var model: AppModel?

    func applicationWillFinishLaunching(_ notification: Notification) {
        let stored = UserDefaults.standard.string(forKey: AppAppearance.storageKey)
        AppAppearance.resolve(stored ?? AppAppearance.system.rawValue).apply()
    }

    func applicationWillTerminate(_ notification: Notification) {
        Self.model?.emergencyStop()
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
        .windowStyle(.automatic)
        .commands {
            SidebarCommands()
        }

        Settings {
            SettingsView()
        }
    }
}
