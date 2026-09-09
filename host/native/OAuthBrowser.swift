import AppKit

// The URL stays in the private helper and the OS launch event. Test drivers may
// choose an installed application explicitly; production resolves the default.
enum OAuthBrowserFailure: Error { case invalidURL, applicationUnavailable, openFailed }
@MainActor func openOAuthBrowser(_ url: URL, applicationURL: URL? = nil,
                                configuration: NSWorkspace.OpenConfiguration = NSWorkspace.OpenConfiguration()) async throws {
    guard url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else { throw OAuthBrowserFailure.invalidURL }
    _ = NSApplication.shared
    guard let application = applicationURL ?? NSWorkspace.shared.urlForApplication(toOpen: url) else { throw OAuthBrowserFailure.applicationUnavailable }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        NSWorkspace.shared.open([url], withApplicationAt: application, configuration: configuration) { runningApplication, error in
            guard error == nil, runningApplication != nil else {
                continuation.resume(throwing: OAuthBrowserFailure.openFailed)
                return
            }
            continuation.resume()
        }
    }
}
