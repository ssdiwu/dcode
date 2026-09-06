import { join } from "node:path";
/** Development and packaged layouts are deliberately explicit and tested. */
export function resolveClientPaths(
  mainDirectory: string,
  packaged: boolean,
  resources: string,
) {
  return {
    host: packaged
      ? join(resources, "host", "dist", "src", "index.js")
      : join(
          mainDirectory,
          "..",
          "..",
          "..",
          "..",
          "host",
          "dist",
          "src",
          "index.js",
        ),
    renderer: join(mainDirectory, "..", "..", "renderer", "index.html"),
    icon: packaged
      ? join(resources, "AppIcon.png")
      : join(
          mainDirectory,
          "..",
          "..",
          "..",
          "..",
          "app",
          "Resources",
          "AppIcon.png",
        ),
  };
}
