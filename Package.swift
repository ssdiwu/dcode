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
    dependencies: [
        .package(url: "https://github.com/nalexn/ViewInspector", exact: "0.10.3"),
    ],
    targets: [
        .executableTarget(
            name: "PiDCode",
            path: "app/Sources/PiDCode",
            exclude: ["README.md"]
        ),
        .testTarget(
            name: "PiDCodeTests",
            dependencies: [
                "PiDCode",
                .product(name: "ViewInspector", package: "ViewInspector"),
            ],
            path: "app/Tests/PiDCodeTests"
        ),
    ]
)
