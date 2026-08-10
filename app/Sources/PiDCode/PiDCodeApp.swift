import AppKit
import SwiftUI

@MainActor
final class PiDCodeAppDelegate: NSObject, NSApplicationDelegate {
    static weak var model: AppModel?

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
                .frame(minWidth: 900, minHeight: 620)
                .task {
                    PiDCodeAppDelegate.model = model
                    await model.start()
                }
                .onDisappear {
                    Task { await model.shutdown() }
                }
        }
        .defaultSize(width: 1_240, height: 820)
        .windowStyle(.automatic)
        .commands {
            SidebarCommands()
        }
    }
}
