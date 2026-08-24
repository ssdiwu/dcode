import AppKit
import Foundation
import UserNotifications


enum CompletionNotificationSettings {
    static let enabledStorageKey = "dcode.notifications.completionEnabled"
}
enum CompletionNotificationAuthorizationState: String, Equatable, Sendable {
    case notDetermined
    case authorized
    case denied
    case restricted

    var label: String {
        switch self {
        case .notDetermined: "未请求"
        case .authorized: "已允许"
        case .denied: "已拒绝"
        case .restricted: "系统限制"
        }
    }
}

@MainActor
protocol CompletionNotificationProviding: AnyObject {
    func authorizationState() async -> CompletionNotificationAuthorizationState
    func requestAuthorization() async throws -> Bool
    func add(_ request: UNNotificationRequest) async throws
}

@MainActor
final class SystemCompletionNotificationProvider: CompletionNotificationProviding {
    private let injectedCenter: UNUserNotificationCenter?

    private var center: UNUserNotificationCenter { injectedCenter ?? .current() }

    init(center: UNUserNotificationCenter? = nil) {
        self.injectedCenter = center
    }

    func authorizationState() async -> CompletionNotificationAuthorizationState {
        await withCheckedContinuation { continuation in
            center.getNotificationSettings { settings in
                let state: CompletionNotificationAuthorizationState
                switch settings.authorizationStatus {
                case .notDetermined: state = .notDetermined
                case .authorized, .provisional: state = .authorized
                case .denied: state = .denied
                @unknown default: state = .restricted
                }
                continuation.resume(returning: state)
            }
        }
    }

    func requestAuthorization() async throws -> Bool {
        try await withCheckedThrowingContinuation { continuation in
            center.requestAuthorization(options: [.alert, .sound]) { granted, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: granted) }
            }
        }
    }

    func add(_ request: UNNotificationRequest) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            center.add(request) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: ()) }
            }
        }
    }
}

@MainActor
final class CompletionNotificationService {

    let provider: CompletionNotificationProviding

    init(provider: CompletionNotificationProviding = SystemCompletionNotificationProvider()) {
        self.provider = provider
    }

    func authorizationState() async -> CompletionNotificationAuthorizationState {
        await provider.authorizationState()
    }

    func requestAuthorization() async -> CompletionNotificationAuthorizationState {
        do {
            _ = try await provider.requestAuthorization()
        } catch {
            return await provider.authorizationState()
        }
        return await provider.authorizationState()
    }

    func schedule(
        completionID: String,
        sessionID: String,
        entryID: String,
        sessionName: String
    ) async throws {
        let content = UNMutableNotificationContent()
        content.title = "D Code 已完成"
        content.subtitle = "D Code · \(sessionName)"
        content.body = "任务已经完成，点击查看结果"
        content.sound = .default
        content.userInfo = [
            "completionID": completionID,
            "sessionID": sessionID,
            "entryID": entryID,
        ]
        try await provider.add(UNNotificationRequest(
            identifier: completionID,
            content: content,
            trigger: nil
        ))
    }

    static func openSystemNotificationSettings() {
        guard let url = URL(
            string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?bundleId=com.diwu.pidcode"
        ) else { return }
        NSWorkspace.shared.open(url)
    }
}
