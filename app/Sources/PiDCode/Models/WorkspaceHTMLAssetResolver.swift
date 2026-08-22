import Foundation

/// HTML 预览的本机资源通道（ADR 0026 决定 4）：预览 HTML 从内存缓冲区注入，
/// 相对资源引用经自定义 `dcode-asset://` scheme 回到 Swift，解析回授权根内的
/// 绝对路径后由 WKURLSchemeHandler 用安全路径读取；越界请求在解析阶段即失败。
enum WorkspaceHTMLAssetScheme {
    static let name = "dcode-asset"
    static let host = "preview"
    /// 单个预览资源（图片 / 字体 / 媒体等）的读取上限。
    static let maximumResourceBytes = 8 * 1_024 * 1_024

    /// 预览 baseURL：`dcode-asset://preview/<HTML 所在目录>/`。
    /// WebKit 按 URL 语义解析相对引用与 `..`，因此 path 直接承载目录绝对路径；
    /// 目录型 baseURL 必须以尾斜杠收尾，否则相对引用会替换掉最后一段目录名。
    static func makeBaseURL(directoryPath: String) -> URL? {
        var components = URLComponents()
        components.scheme = name
        components.host = host
        components.path = directoryPath.hasSuffix("/") ? directoryPath : directoryPath + "/"
        return components.url
    }

    /// 把资源请求 URL 解析回授权根内的绝对文件路径；scheme 不符、非绝对路径或
    /// 越出授权根（同一标准化语义比较）返回 nil。query / fragment 忽略。
    static func resolveFilePath(from url: URL, sourceFolderPath: String) -> String? {
        guard url.scheme?.lowercased() == name,
              url.host?.lowercased() == host,
              !url.path.isEmpty,
              url.path.hasPrefix("/") else { return nil }
        let root = WorkspaceFileReader.standardizedAbsolutePath(sourceFolderPath)
        let candidate = WorkspaceFileReader.standardizedAbsolutePath(url.path)
        guard WorkspaceFileReader.relativeComponents(of: candidate, inside: root) != nil else {
            return nil
        }
        return candidate
    }
}

enum WorkspaceHTMLAssetMIME {
    private static let byExtension: [String: String] = [
        "html": "text/html", "htm": "text/html", "css": "text/css",
        "js": "text/javascript", "mjs": "text/javascript",
        "json": "application/json", "txt": "text/plain", "xml": "application/xml",
        "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "gif": "image/gif", "webp": "image/webp", "avif": "image/avif", "ico": "image/x-icon",
        "bmp": "image/bmp", "woff": "font/woff", "woff2": "font/woff2",
        "ttf": "font/ttf", "otf": "font/otf", "mp4": "video/mp4", "webm": "video/webm",
        "mp3": "audio/mpeg", "wav": "audio/wav", "pdf": "application/pdf",
    ]

    static func mimeType(forPath path: String) -> String {
        byExtension[URL(fileURLWithPath: path).pathExtension.lowercased()]
            ?? "application/octet-stream"
    }
}
