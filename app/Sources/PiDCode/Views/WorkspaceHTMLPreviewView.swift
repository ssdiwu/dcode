import SwiftUI
import WebKit

// MARK: - 本机资源 scheme handler（ADR 0026 决定 4）

/// `dcode-asset://` 请求处理器：解析回授权根内绝对路径后经安全路径读取原始
/// 字节（图片 / CSS / 字体等，上限 8MB）；越界、符号链接、缺失、授权撤销
/// 一律失败，不提供任意文件系统访问。回调必须回到主线程（WebKit 约定），
/// stop 后不得再触碰 task。
final class WorkspaceHTMLAssetSchemeHandler: NSObject, WKURLSchemeHandler {
    let sourceFolderPath: String
    /// 授权状态由 SwiftUI update 同步；撤销后继续编辑可以，但资源读取停止。
    var isAuthorized: Bool
    /// task 与其加载任务都只在主线程持有；Swift 6 严格并发下 WKURLSchemeTask
    /// 不跨隔离域传递，后台任务只回传 Sendable 结果。
    @MainActor private var activeTasks: [ObjectIdentifier: WKURLSchemeTask] = [:]
    private var loadTasks: [ObjectIdentifier: Task<Void, Never>] = [:]

    init(sourceFolderPath: String, isAuthorized: Bool = true) {
        self.sourceFolderPath = sourceFolderPath
        self.isAuthorized = isAuthorized
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        MainActor.assumeIsolated {
            let handle = ObjectIdentifier(task)
            guard isAuthorized,
                  let url = task.request.url,
                  let filePath = WorkspaceHTMLAssetScheme.resolveFilePath(
                      from: url,
                      sourceFolderPath: sourceFolderPath
                  ) else {
                task.didFailWithError(URLError(.fileDoesNotExist))
                return
            }
            let root = sourceFolderPath
            activeTasks[handle] = task
            loadTasks[handle] = Task.detached(priority: .userInitiated) { [weak self] in
                let outcome: Result<Data, WorkspaceFileReaderError>
                do {
                    let data = try await WorkspaceFileReader.readRawBytes(
                        path: filePath,
                        sourceFolderPath: root,
                        maximumBytes: WorkspaceHTMLAssetScheme.maximumResourceBytes
                    )
                    outcome = .success(data)
                } catch let error as WorkspaceFileReaderError {
                    outcome = .failure(error)
                } catch {
                    outcome = .failure(.cannotRead)
                }
                guard !Task.isCancelled else { return }
                await MainActor.run { [weak self] in
                    guard let self,
                          let schemeTask = self.activeTasks.removeValue(forKey: handle) else { return }
                    self.loadTasks.removeValue(forKey: handle)
                    switch outcome {
                    case let .success(data):
                        let response = URLResponse(
                            url: url,
                            mimeType: WorkspaceHTMLAssetMIME.mimeType(forPath: filePath),
                            expectedContentLength: data.count,
                            textEncodingName: nil
                        )
                        schemeTask.didReceive(response)
                        schemeTask.didReceive(data)
                        schemeTask.didFinish()
                    case let .failure(error):
                        schemeTask.didFailWithError(error)
                    }
                }
            }
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        MainActor.assumeIsolated {
            let handle = ObjectIdentifier(urlSchemeTask)
            loadTasks[handle]?.cancel()
            loadTasks.removeValue(forKey: handle)
            activeTasks.removeValue(forKey: handle)
        }
    }
}

// MARK: - WKWebView 包装

/// 隔离预览（ADR 0026 决定 2、3、5）：脚本默认允许、nonPersistent 存储、
/// 内容从内存缓冲区注入（约 400ms 停顿节流）；网络默认由内容规则阻断，
/// “本次允许”后移除规则并重注入；外部导航一律拦截并上报触发询问。
struct HTMLPreviewWKWebView: NSViewRepresentable {
    let html: String
    let baseURL: URL
    let sourceFolderPath: String
    let networkAllowed: Bool
    let isAuthorized: Bool
    let onNetworkAttempt: (URL) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        let handler = WorkspaceHTMLAssetSchemeHandler(sourceFolderPath: sourceFolderPath)
        configuration.setURLSchemeHandler(handler, forURLScheme: WorkspaceHTMLAssetScheme.name)
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        context.coordinator.registerAssetHandler(handler)
        context.coordinator.attach(webView: webView, representable: self)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.attach(webView: webView, representable: self)
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        private var onNetworkAttempt: ((URL) -> Void)?
        private weak var webView: WKWebView?
        private var assetHandler: WorkspaceHTMLAssetSchemeHandler?
        private var injectionTask: Task<Void, Never>?
        private var lastInjected: (html: String, baseURL: URL, networkAllowed: Bool)?
        private var networkBlockRule: WKContentRuleList?
        private var ruleState: Bool?

        func registerAssetHandler(_ handler: WorkspaceHTMLAssetSchemeHandler) {
            assetHandler = handler
        }

        func attach(webView: WKWebView, representable: HTMLPreviewWKWebView) {
            let firstAttach = self.webView == nil
            self.webView = webView
            self.onNetworkAttempt = representable.onNetworkAttempt
            assetHandler?.isAuthorized = representable.isAuthorized
            scheduleInjection(
                html: representable.html,
                baseURL: representable.baseURL,
                networkAllowed: representable.networkAllowed,
                immediate: firstAttach
            )
        }

        /// 编辑停顿节流重注入；内容、baseURL 或联网策略任一变化都重新加载。
        private func scheduleInjection(
            html: String,
            baseURL: URL,
            networkAllowed: Bool,
            immediate: Bool
        ) {
            if lastInjected?.html == html,
               lastInjected?.baseURL == baseURL,
               lastInjected?.networkAllowed == networkAllowed {
                return
            }
            injectionTask?.cancel()
            injectionTask = Task { [weak self] in
                if !immediate {
                    try? await Task.sleep(for: .milliseconds(400))
                }
                guard !Task.isCancelled, let self, let webView = self.webView else { return }
                await self.applyNetworkPolicy(allowed: networkAllowed)
                guard !Task.isCancelled else { return }
                webView.loadHTMLString(html, baseURL: baseURL)
                self.lastInjected = (html, baseURL, networkAllowed)
            }
        }

        private func applyNetworkPolicy(allowed: Bool) async {
            guard ruleState != allowed else { return }
            guard let webView else { return }
            let controller = webView.configuration.userContentController
            if allowed {
                if let rule = networkBlockRule {
                    controller.remove(rule)
                    networkBlockRule = nil
                }
                ruleState = true
                return
            }
            if networkBlockRule == nil {
                let encoded = #"{"trigger":{"url-filter":"^https?:.*"},"action":{"type":"block"}}"#
                networkBlockRule = try? await WKContentRuleListStore.default()
                    .compileContentRuleList(forIdentifier: nil, encodedContentRuleList: encoded)
            }
            if let rule = networkBlockRule {
                controller.add(rule)
            }
            ruleState = false
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            let scheme = url.scheme?.lowercased() ?? ""
            if scheme == "http" || scheme == "https" {
                // 主导航永不加载远程页面（D Code 不做浏览器）；
                // 上报尝试触发“本次允许”询问（ADR 0026 决定 3）。
                onNetworkAttempt?(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }
}

// MARK: - 预览面板（右栏）

/// HTML 即时预览面板：头部为联网策略 / 询问条 + “跟随未保存缓冲区”标注，
/// 主体为隔离 WKWebView。
struct WorkspaceHTMLPreviewView: View {
    @Environment(AppModel.self) private var model
    let path: String
    let draftText: String
    let sourceFolderPath: String
    let directoryPath: String
    let isDirty: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            if let baseURL = WorkspaceHTMLAssetScheme.makeBaseURL(directoryPath: directoryPath) {
                HTMLPreviewWKWebView(
                    html: draftText,
                    baseURL: baseURL,
                    sourceFolderPath: sourceFolderPath,
                    networkAllowed: model.htmlPreview.isNetworkAllowed(path: path),
                    isAuthorized: model.workspaceFileTabs.first(where: { $0.path == path })?
                        .authorizationAvailable ?? false,
                    onNetworkAttempt: { url in
                        model.htmlPreview.recordNetworkAttempt(
                            path: path,
                            url: url.absoluteString
                        )
                    }
                )
            } else {
                ContentUnavailableView("无法建立预览", systemImage: "safari")
            }
        }
        .background(DCodeWorkbenchSurfacePolicy.centralCanvas.color)
    }

    @ViewBuilder
    private var header: some View {
        VStack(spacing: 0) {
            HStack(spacing: PiDCodeMetrics.spacingStandard) {
                Label("即时预览", systemImage: "eye")
                    .font(.caption.weight(.semibold))
                Text(isDirty ? "跟随未保存缓冲区" : "与磁盘一致")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer(minLength: PiDCodeMetrics.spacingGroup)
                networkStatus
            }
            .padding(.horizontal, PiDCodeMetrics.spacingSection)
            .frame(minHeight: 36)
            if model.htmlPreview.pendingAttemptPath == path,
               let attempted = model.htmlPreview.pendingAttemptURL {
                HStack(spacing: PiDCodeMetrics.spacingStandard) {
                    Label(
                        "该页面尝试联网（已阻止）：\(attempted)",
                        systemImage: "network.badge.shield.half.filled"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(attempted)
                    Spacer(minLength: PiDCodeMetrics.spacingGroup)
                    Button("本次允许") {
                        model.htmlPreview.allowNetwork(path: path)
                    }
                    .controlSize(.small)
                    Button("保持阻止") {
                        model.htmlPreview.keepBlocked()
                    }
                    .controlSize(.small)
                }
                .padding(.horizontal, PiDCodeMetrics.spacingSection)
                .padding(.vertical, 6)
                .background(Color.orange.opacity(0.08))
            }
            Rectangle()
                .fill(Color.primary.opacity(0.07))
                .frame(height: 1)
                .accessibilityHidden(true)
        }
    }

    @ViewBuilder
    private var networkStatus: some View {
        if model.htmlPreview.isNetworkAllowed(path: path) {
            Text("联网：本次已允许")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            Label("联网资源：已阻止", systemImage: "lock.shield")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
