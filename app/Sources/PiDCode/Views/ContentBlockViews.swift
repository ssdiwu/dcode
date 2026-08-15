import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct CodeBlockView: View {
    let language: String?
    let source: String
    @State private var copied = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(language.flatMap { $0.isEmpty ? nil : $0 } ?? "Code")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    copyText(source)
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.2))
                        copied = false
                    }
                } label: {
                    Label(copied ? "已复制" : "复制", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
                .frame(minHeight: PiDCodeMetrics.compactControlHeight)
                .accessibilityLabel(copied ? "代码已复制" : "复制代码")
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 36)
            .background(Color.primary.opacity(0.035))
            Divider()
            ScrollView(.horizontal) {
                Text(source.isEmpty ? " " : source)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(12)
            }
            .frame(maxHeight: 360)
        }
        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius))
        .overlay {
            RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius)
                .strokeBorder(Color.primary.opacity(0.1))
        }
        .accessibilityElement(children: .contain)
    }
}

struct MermaidDiagramView: View {
    @Environment(AppModel.self) private var model
    let source: String
    @State private var result: MermaidRenderResult?
    @State private var zoom = 1.0
    @State private var copiedSource = false
    @State private var copiedImage = false
    @State private var exportError: String?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
        }
        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius))
        .overlay {
            RoundedRectangle(cornerRadius: PiDCodeMetrics.controlRadius)
                .strokeBorder(Color.primary.opacity(0.1))
        }
        .task(id: source) {
            result = await model.renderMermaid(source: source)
        }
        .accessibilityElement(children: .contain)
    }

    private var header: some View {
        HStack(spacing: 4) {
            Label(result?.kind.map { "Mermaid · \($0)" } ?? "Mermaid", systemImage: "point.3.connected.trianglepath.dotted")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Button {
                zoom = max(0.6, zoom - 0.1)
            } label: {
                Image(systemName: "minus.magnifyingglass")
            }
            .buttonStyle(IconActionStyle())
            .disabled(zoom <= 0.6 || result?.rendered != true)
            .help("缩小图表")
            .accessibilityLabel("缩小 Mermaid 图表")
            Text(zoom, format: .percent.precision(.fractionLength(0)))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 42)
            Button {
                zoom = min(2.0, zoom + 0.1)
            } label: {
                Image(systemName: "plus.magnifyingglass")
            }
            .buttonStyle(IconActionStyle())
            .disabled(zoom >= 2.0 || result?.rendered != true)
            .help("放大图表")
            .accessibilityLabel("放大 Mermaid 图表")
            Button {
                copyText(source)
                copiedSource = true
                resetCopiedSource()
            } label: {
                Image(systemName: copiedSource ? "checkmark" : "doc.on.doc")
            }
            .buttonStyle(IconActionStyle())
            .help(copiedSource ? "源码已复制" : "复制 Mermaid 源码")
            .accessibilityLabel(copiedSource ? "源码已复制" : "复制 Mermaid 源码")
            Button(action: copyRenderedImage) {
                Image(systemName: copiedImage ? "checkmark" : "photo.on.rectangle")
            }
            .buttonStyle(IconActionStyle())
            .disabled(result?.rendered != true)
            .help(copiedImage ? "图片已复制" : "复制图表图片")
            .accessibilityLabel(copiedImage ? "图片已复制" : "复制图表图片")
            Button(action: exportPNG) {
                Image(systemName: "square.and.arrow.down")
            }
            .buttonStyle(IconActionStyle())
            .disabled(result?.rendered != true)
            .help("导出 PNG")
            .accessibilityLabel("导出 Mermaid PNG")
        }
        .padding(.leading, 12)
        .padding(.trailing, 4)
        .frame(minHeight: 36)
        .background(Color.primary.opacity(0.035))
    }

    @ViewBuilder
    private var content: some View {
        if let result {
            if result.rendered {
                VStack(alignment: .leading, spacing: 8) {
                    ScrollView([.horizontal, .vertical]) {
                        MermaidArtView(result: result, zoom: zoom)
                            .padding(18)
                    }
                    .frame(maxHeight: 440)
                    if let warning = result.warnings?.first, !warning.isEmpty {
                        Label(warning, systemImage: "exclamationmark.circle")
                            .font(.caption)
                            .foregroundStyle(.orange)
                            .textSelection(.enabled)
                            .padding(.horizontal, 12)
                            .padding(.bottom, 10)
                    }
                    if let exportError {
                        Label(exportError, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.red)
                            .padding(.horizontal, 12)
                            .padding(.bottom, 10)
                    }
                }
                .accessibilityLabel("Mermaid 图表 \(result.kind ?? "")")
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Label(result.error ?? "无法渲染 Mermaid 图表。", systemImage: "exclamationmark.triangle.fill")
                        .font(.callout)
                        .foregroundStyle(.orange)
                    CodeBlockView(language: "mermaid", source: source)
                }
                .padding(12)
            }
        } else {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("正在渲染 Mermaid…")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 100)
            .accessibilityLabel("正在渲染 Mermaid")
        }
    }

    private func renderedImage() -> NSImage? {
        guard let result, result.rendered else { return nil }
        let renderer = ImageRenderer(content:
            MermaidArtView(result: result, zoom: zoom)
                .padding(24)
                .background(Color.white)
                .environment(\.colorScheme, .light)
        )
        renderer.scale = 2
        return renderer.nsImage
    }

    private func copyRenderedImage() {
        guard let image = renderedImage() else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.writeObjects([image])
        copiedImage = true
        resetCopiedImage()
    }

    private func exportPNG() {
        guard let image = renderedImage(),
              let tiff = image.tiffRepresentation,
              let representation = NSBitmapImageRep(data: tiff),
              let data = representation.representation(using: .png, properties: [:]) else {
            exportError = "无法生成 PNG 数据。"
            return
        }
        let panel = NSSavePanel()
        panel.title = "导出 Mermaid 图表"
        panel.nameFieldStringValue = "diagram.png"
        panel.allowedContentTypes = [.png]
        panel.canCreateDirectories = true
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            do {
                try data.write(to: url, options: .atomic)
                exportError = nil
            } catch {
                exportError = DiagnosticSanitizer.redact(error.localizedDescription)
            }
        }
    }

    private func resetCopiedSource() {
        Task {
            try? await Task.sleep(for: .seconds(1.2))
            copiedSource = false
        }
    }

    private func resetCopiedImage() {
        Task {
            try? await Task.sleep(for: .seconds(1.2))
            copiedImage = false
        }
    }
}

private struct MermaidArtView: View {
    let result: MermaidRenderResult
    let zoom: Double

    var body: some View {
        Text(attributedArt)
            .font(.system(size: 12.5 * zoom, design: .monospaced))
            .lineSpacing(2 * zoom)
            .textSelection(.enabled)
            .fixedSize(horizontal: true, vertical: true)
            .accessibilityLabel((result.lines ?? []).joined(separator: "\n"))
    }

    private var attributedArt: AttributedString {
        var output = AttributedString()
        if let rows = result.styled, !rows.isEmpty {
            for (rowIndex, row) in rows.enumerated() {
                for span in row {
                    var fragment = AttributedString(span.text)
                    fragment.foregroundColor = color(for: span.cls)
                    output.append(fragment)
                }
                if rowIndex < rows.count - 1 { output.append(AttributedString("\n")) }
            }
        } else {
            output = AttributedString((result.lines ?? []).joined(separator: "\n"))
        }
        return output
    }

    private func color(for semanticClass: String) -> Color {
        switch semanticClass {
        case "edge": Color.accentColor
        case "edgeLabel": .secondary
        case "border": .secondary
        case "title": Color.accentColor
        case "none": .clear
        default: .primary
        }
    }
}

struct TranscriptImageView: View {
    let presentation: TranscriptImagePresentation
    private let image: NSImage?
    @State private var showingPreview = false

    init(presentation: TranscriptImagePresentation) {
        self.presentation = presentation
        image = NSImage(data: presentation.data)
    }

    var body: some View {
        Group {
            if let image {
                Button {
                    showingPreview = true
                } label: {
                    Image(nsImage: image)
                        .resizable()
                        .interpolation(.high)
                        .scaledToFill()
                        .frame(width: 104, height: 104)
                        .clipped()
                        .background(Color.primary.opacity(0.035))
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .strokeBorder(Color.primary.opacity(0.1), lineWidth: 1)
                        }
                }
                .buttonStyle(.plain)
                .help("查看原图")
                .accessibilityLabel("图片，\(presentation.pixelWidth) × \(presentation.pixelHeight) 像素")
                .accessibilityHint("打开原图预览")
                .sheet(isPresented: $showingPreview) {
                    TranscriptImagePreview(
                        image: image,
                        pixelWidth: presentation.pixelWidth,
                        pixelHeight: presentation.pixelHeight,
                        dismiss: { showingPreview = false }
                    )
                }
            } else {
                Label("无法显示图片", systemImage: "photo.badge.exclamationmark")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct TranscriptImagePreview: View {
    let image: NSImage
    let pixelWidth: Int
    let pixelHeight: Int
    let dismiss: () -> Void
    @State private var zoom = 1.0

    private var fittedSize: CGSize {
        let width = max(CGFloat(pixelWidth), 1)
        let height = max(CGFloat(pixelHeight), 1)
        let scale = min(1, 720 / width, 520 / height)
        return CGSize(width: width * scale, height: height * scale)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: PiDCodeMetrics.spacingTight) {
                Text("原图预览")
                    .font(.headline)
                Text("\(pixelWidth) × \(pixelHeight)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer(minLength: PiDCodeMetrics.spacingSection)
                Button {
                    zoom = max(0.5, zoom - 0.25)
                } label: {
                    Image(systemName: "minus.magnifyingglass")
                }
                .buttonStyle(IconActionStyle())
                .disabled(zoom <= 0.5)
                .help("缩小图片")
                Text(zoom, format: .percent.precision(.fractionLength(0)))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(width: 44)
                Button {
                    zoom = min(4, zoom + 0.25)
                } label: {
                    Image(systemName: "plus.magnifyingglass")
                }
                .buttonStyle(IconActionStyle())
                .disabled(zoom >= 4)
                .help("放大图片")
                Button("完成", action: dismiss)
                    .keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, PiDCodeMetrics.spacingSection)
            .frame(minHeight: 52)

            Divider()

            ScrollView([.horizontal, .vertical]) {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .frame(
                        width: fittedSize.width * zoom,
                        height: fittedSize.height * zoom
                    )
                    .padding(PiDCodeMetrics.spacingSection)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(Color.black.opacity(0.92))
        }
        .frame(minWidth: 680, minHeight: 520)
        .accessibilityElement(children: .contain)
    }
}

private func copyText(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}
