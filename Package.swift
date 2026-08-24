// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PiDCode",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "PiDCode", targets: ["PiDCode"]),
        .executable(name: "DCodeRelaunchHelper", targets: ["DCodeRelaunchHelper"]),
    ],
    dependencies: [
        .package(url: "https://github.com/nalexn/ViewInspector", exact: "0.10.3"),
    ],
    targets: [
        .target(
            name: "RelaunchCore",
            path: "app/Sources/RelaunchCore"
        ),
        .executableTarget(
            name: "DCodeRelaunchHelper",
            dependencies: ["RelaunchCore"],
            path: "app/Sources/RelaunchHelper"
        ),
        .executableTarget(
            name: "PiDCode",
            dependencies: ["RelaunchCore"],
            path: "app/Sources/PiDCode",
            exclude: ["README.md"],
            resources: [
                .process("Resources"),
            ]
        ),
        .testTarget(
            name: "PiDCodeTests",
            dependencies: [
                "PiDCode",
                "RelaunchCore",
                .product(name: "ViewInspector", package: "ViewInspector"),
            ],
            path: "app/Tests/PiDCodeTests"
        ),
    ]
)
