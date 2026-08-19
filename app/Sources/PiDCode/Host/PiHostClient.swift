import Foundation

final class HostProcessLifecycle: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?
    private var expectedTermination = false

    func install(_ process: Process) {
        lock.withLock {
            self.process = process
            expectedTermination = false
        }
    }

    func clear(_ process: Process) {
        lock.withLock {
            if self.process === process { self.process = nil }
        }
    }

    func terminate(expected: Bool = false) {
        lock.withLock {
            guard let process, process.isRunning else { return }
            expectedTermination = expectedTermination || expected
            process.terminate()
        }
    }

    func consumeExpectedTermination(for process: Process) -> Bool {
        lock.withLock {
            guard self.process === process else { return false }
            let expected = expectedTermination
            expectedTermination = false
            return expected
        }
    }
}

actor PiHostClient: HostProviding {
    typealias EventSink = HostEventSink

    nonisolated let lifecycle = HostProcessLifecycle()

    private let configuration: HostLaunchConfiguration
    private let eventSink: EventSink
    private var process: Process?
    private var input: FileHandle?
    private var outputHandle: FileHandle?
    private var errorHandle: FileHandle?
    private var outputTask: Task<Void, Never>?
    private var errorBuffer = Data()
    private var pending: [String: CheckedContinuation<JSONValue, any Error>] = [:]
    private var nextRequestNumber = 0
    private var started = false
    private var stopping = false

    init(configuration: HostLaunchConfiguration, eventSink: @escaping EventSink) {
        self.configuration = configuration
        self.eventSink = eventSink
    }

    func start() throws {
        guard !started else { throw PiHostClientError.alreadyStarted }

        let process = Process()
        let inputPipe = Pipe()
        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.executableURL = configuration.nodeURL
        process.arguments = configuration.arguments
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        process.environment = HostProcessEnvironment.make(agentDirectoryURL: configuration.agentDirectoryURL)
        process.standardInput = inputPipe
        process.standardOutput = outputPipe
        process.standardError = errorPipe
        process.terminationHandler = { [weak self] terminated in
            let status = terminated.terminationStatus
            Task { await self?.processDidTerminate(terminated, status: status) }
        }

        do {
            try process.run()
        } catch {
            throw PiHostClientError.launchFailure(error.localizedDescription)
        }

        let outputHandle = outputPipe.fileHandleForReading
        let errorHandle = errorPipe.fileHandleForReading
        self.process = process
        input = inputPipe.fileHandleForWriting
        self.outputHandle = outputHandle
        self.errorHandle = errorHandle
        errorBuffer.removeAll(keepingCapacity: true)
        started = true
        stopping = false
        lifecycle.install(process)
        outputTask = Task { [weak self] in
            await self?.consumeOutput(outputHandle)
        }
        errorHandle.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil }
            else { Task { await self?.consumeErrorData(data) } }
        }
    }

    func request<T: Decodable & Sendable>(
        _ method: String,
        params: [String: JSONValue] = [:],
        as type: T.Type = T.self
    ) async throws -> T {
        let value = try await requestValue(method, params: params)
        do {
            return try value.decoded(type)
        } catch {
            throw PiHostClientError.invalidEnvelope("\(method) 结果无法解码：\(error.localizedDescription)")
        }
    }

    func requestValue(_ method: String, params: [String: JSONValue] = [:]) async throws -> JSONValue {
        guard started, let input else { throw PiHostClientError.notStarted }
        nextRequestNumber += 1
        let id = "mac-\(nextRequestNumber)"
        let data: Data
        do {
            data = try HostProtocolCodec.encodeRequest(id: id, method: method, params: params)
        } catch {
            throw PiHostClientError.writeFailure(error.localizedDescription)
        }

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                pending[id] = continuation
                do {
                    try input.write(contentsOf: data)
                } catch {
                    pending.removeValue(forKey: id)?.resume(
                        throwing: PiHostClientError.writeFailure(error.localizedDescription)
                    )
                }
            }
        } onCancel: {
            Task { await self.cancelRequest(id) }
        }
    }

    func shutdown() async {
        guard started, !stopping else { return }
        stopping = true
        _ = try? await requestValue("host.shutdown")
        for _ in 0..<30 {
            if process?.isRunning != true { return }
            try? await Task.sleep(for: .milliseconds(100))
        }
        lifecycle.terminate()
    }

    private func cancelRequest(_ id: String) {
        pending.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }

    private func consumeOutput(_ output: FileHandle) async {
        do {
            for try await line in output.bytes.lines {
                guard !line.isEmpty else { continue }
                do {
                    try await receive(HostProtocolCodec.decode(line: line))
                } catch {
                    await eventSink(HostEvent(name: "protocol.decodeError", data: .object([
                        "message": .string(DiagnosticSanitizer.redact(error.localizedDescription)),
                    ])))
                }
            }
        } catch {
            guard !Task.isCancelled else { return }
            await eventSink(HostEvent(name: "host.outputError", data: .object([
                "message": .string(DiagnosticSanitizer.redact(error.localizedDescription)),
            ])))
        }
    }

    private func consumeErrorData(_ data: Data) async {
        errorBuffer.append(data)
        if errorBuffer.count > 1_024 * 1_024, !errorBuffer.contains(0x0A) {
            let message = String(decoding: errorBuffer.prefix(4_096), as: UTF8.self)
            errorBuffer.removeAll(keepingCapacity: true)
            await eventSink(HostEvent(name: "host.stderr", data: .object([
                "message": .string(DiagnosticSanitizer.redact(message)),
            ])))
            return
        }
        while let newline = errorBuffer.firstIndex(of: 0x0A) {
            let lineData = errorBuffer.prefix(upTo: newline)
            errorBuffer.removeSubrange(...newline)
            var line = String(decoding: lineData, as: UTF8.self)
            if line.last == "\r" { line.removeLast() }
            if !line.isEmpty {
                await eventSink(HostEvent(name: "host.stderr", data: .object([
                    "message": .string(DiagnosticSanitizer.redact(line)),
                ])))
            }
        }
    }

    private func receive(_ message: HostInboundMessage) async throws {
        switch message {
        case let .response(id, _, result):
            pending.removeValue(forKey: id)?.resume(returning: result)
        case let .failure(id, _, error):
            pending.removeValue(forKey: id)?.resume(throwing: PiHostClientError.hostFailure(error))
        case let .event(event):
            await eventSink(event)
        }
    }

    private func processDidTerminate(_ terminated: Process, status: Int32) async {
        let expectedTermination = stopping || lifecycle.consumeExpectedTermination(for: terminated)
        lifecycle.clear(terminated)
        guard process === terminated else { return }
        outputTask?.cancel()
        outputTask = nil
        errorHandle?.readabilityHandler = nil
        outputHandle = nil
        errorHandle = nil
        process = nil
        input = nil
        started = false
        let error = PiHostClientError.processEnded(status)
        for continuation in pending.values { continuation.resume(throwing: error) }
        pending.removeAll()
        await eventSink(HostEvent(name: "host.processEnded", data: .object([
            "status": .number(Double(status)),
            "expected": .bool(expectedTermination),
        ])))
    }
}
