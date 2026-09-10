import Security

// SecItem defaults to the file-based login keychain. Its legacy shim needs the
// process-scoped SecKeychain interaction switch; DP-only query flags are not a substitute.
func withKeychainInteraction<T>(_ allowed: Bool, _ operation: () throws -> T) throws -> T {
    var previous: DarwinBoolean = true
    guard SecKeychainGetUserInteractionAllowed(&previous) == errSecSuccess,
          SecKeychainSetUserInteractionAllowed(allowed) == errSecSuccess else { throw KeychainInteractionFailure.unavailable }
    defer { SecKeychainSetUserInteractionAllowed(previous.boolValue) }
    return try operation()
}
enum KeychainInteractionFailure: Error { case unavailable }
