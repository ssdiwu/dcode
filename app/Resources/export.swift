#!/usr/bin/env swift
// Export the approved C-A master into every native/Web brand resource.
// Run: swift app/Resources/export.swift (macOS; no third-party dependencies).
import AppKit

enum BrandExportError: Error {
    case invalidMaster(String)
    case renderingFailed
    case iconutilFailed(Int32)
}

final class MasterParser: NSObject, XMLParserDelegate {
    var paths: [String] = []
    var viewBox: String?
    func parser(_ parser: XMLParser, didStartElement name: String,
                namespaceURI: String?, qualifiedName: String?,
                attributes: [String: String]) {
        if name == "svg" { viewBox = attributes["viewBox"] }
        if name == "path", let data = attributes["d"] { paths.append(data) }
    }
}

func loadMaster(_ url: URL) throws -> CGPath {
    let delegate = MasterParser()
    let parser = XMLParser(data: try Data(contentsOf: url))
    parser.shouldResolveExternalEntities = false
    parser.delegate = delegate
    guard parser.parse(), delegate.viewBox == "0 0 1024 1024", delegate.paths.count == 1 else {
        throw BrandExportError.invalidMaster("Expected one path in a 1024-square SVG")
    }
    let source = delegate.paths[0]
    let regex = try NSRegularExpression(pattern: #"[A-Za-z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?"#)
    let tokens = regex.matches(in: source, range: NSRange(source.startIndex..., in: source))
        .compactMap { Range($0.range, in: source).map { String(source[$0]) } }
    var index = 0
    func number() throws -> CGFloat {
        guard index < tokens.count, let value = Double(tokens[index]), value.isFinite else {
            throw BrandExportError.invalidMaster("Invalid coordinate at token \(index)")
        }
        index += 1
        return CGFloat(value)
    }
    func point() throws -> CGPoint { CGPoint(x: try number(), y: try number()) }
    let path = CGMutablePath()
    while index < tokens.count {
        let command = tokens[index]
        index += 1
        switch command {
        case "M": path.move(to: try point())
        case "L": path.addLine(to: try point())
        case "Q":
            let control = try point()
            path.addQuadCurve(to: try point(), control: control)
        case "C":
            let control1 = try point(), control2 = try point()
            path.addCurve(to: try point(), control1: control1, control2: control2)
        case "Z", "z": path.closeSubpath()
        default: throw BrandExportError.invalidMaster("Unsupported path command \(command)")
        }
    }
    guard !path.isEmpty else { throw BrandExportError.invalidMaster("Empty path") }
    return path
}

func tilePath() -> CGPath {
    let path = CGMutablePath()
    path.move(to: CGPoint(x: 306, y: 102))
    path.addLine(to: CGPoint(x: 718, y: 102))
    path.addCurve(to: CGPoint(x: 922, y: 306), control1: CGPoint(x: 854, y: 102), control2: CGPoint(x: 922, y: 170))
    path.addLine(to: CGPoint(x: 922, y: 718))
    path.addCurve(to: CGPoint(x: 718, y: 922), control1: CGPoint(x: 922, y: 854), control2: CGPoint(x: 854, y: 922))
    path.addLine(to: CGPoint(x: 306, y: 922))
    path.addCurve(to: CGPoint(x: 102, y: 718), control1: CGPoint(x: 170, y: 922), control2: CGPoint(x: 102, y: 854))
    path.addLine(to: CGPoint(x: 102, y: 306))
    path.addCurve(to: CGPoint(x: 306, y: 102), control1: CGPoint(x: 102, y: 170), control2: CGPoint(x: 170, y: 102))
    path.closeSubpath()
    return path
}

func render(_ mark: CGPath, size: Int, icon: Bool) throws -> Data {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                                  bytesPerRow: size * 4, space: space,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        throw BrandExportError.renderingFailed
    }
    context.translateBy(x: 0, y: CGFloat(size))
    context.scaleBy(x: CGFloat(size) / 1024, y: -CGFloat(size) / 1024)
    context.setShouldAntialias(true)
    if icon {
        let tile = tilePath()
        context.saveGState()
        context.setShadow(offset: CGSize(width: 0, height: -8), blur: 14,
                          color: CGColor(gray: 0, alpha: 0.15))
        context.setFillColor(CGColor(gray: 0.97, alpha: 1))
        context.addPath(tile)
        context.fillPath()
        context.restoreGState()
        context.saveGState()
        context.addPath(tile)
        context.clip()
        let colors = [CGColor(red: 250/255, green: 250/255, blue: 249/255, alpha: 1),
                      CGColor(red: 240/255, green: 240/255, blue: 239/255, alpha: 1)] as CFArray
        guard let gradient = CGGradient(colorsSpace: space, colors: colors, locations: [0, 1]) else {
            throw BrandExportError.renderingFailed
        }
        context.drawLinearGradient(gradient, start: CGPoint(x: 512, y: 102), end: CGPoint(x: 512, y: 922), options: [])
        context.restoreGState()
        context.setStrokeColor(CGColor(gray: 0.86, alpha: 0.7))
        context.setLineWidth(1)
        context.addPath(tile)
        context.strokePath()
        context.translateBy(x: 132, y: 132)
        context.scaleBy(x: 760/1024, y: 760/1024)
    }
    context.setFillColor(CGColor(gray: 17/255, alpha: 1))
    context.addPath(mark)
    context.drawPath(using: .eoFill)
    guard let image = context.makeImage(),
          let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
        throw BrandExportError.renderingFailed
    }
    return data
}

let resources = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let root = resources.deletingLastPathComponent().deletingLastPathComponent()
let master = try loadMaster(resources.appendingPathComponent("DCodeMark.svg"))
let markPNG = try render(master, size: 1024, icon: false)
try markPNG.write(to: root.appendingPathComponent("client/src/renderer/src/assets/logo.png"), options: .atomic)
let iconset = FileManager.default.temporaryDirectory.appendingPathComponent("DCode-\(UUID().uuidString).iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: iconset) }
let entries: [(Int, [String])] = [
    (16, ["icon_16x16.png"]), (32, ["icon_16x16@2x.png", "icon_32x32.png"]),
    (64, ["icon_32x32@2x.png"]), (128, ["icon_128x128.png"]),
    (256, ["icon_128x128@2x.png", "icon_256x256.png"]),
    (512, ["icon_256x256@2x.png", "icon_512x512.png"]), (1024, ["icon_512x512@2x.png"]),
]
for (size, names) in entries {
    let data = try render(master, size: size, icon: true)
    for name in names { try data.write(to: iconset.appendingPathComponent(name), options: .atomic) }
    if size == 1024 { try data.write(to: resources.appendingPathComponent("AppIcon.png"), options: .atomic) }
}
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", iconset.path, "-o", resources.appendingPathComponent("AppIcon.icns").path]
try process.run()
process.waitUntilExit()
guard process.terminationStatus == 0 else { throw BrandExportError.iconutilFailed(process.terminationStatus) }
print("Exported C-A: AppIcon.png, AppIcon.icns, Web logo.png")
