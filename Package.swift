// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PiDCode",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "PiDCode", targets: ["PiDCode"]),
    ],
    targets: [
        .executableTarget(
            name: "PiDCode",
            path: "app/Sources/PiDCode",
            exclude: ["README.md"]
        ),
        .testTarget(
            name: "PiDCodeTests",
            dependencies: ["PiDCode"],
            path: "app/Tests/PiDCodeTests"
        ),
    ]
)
