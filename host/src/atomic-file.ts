import { randomUUID } from "node:crypto";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Publishes a new file without ever exposing a partial destination document.
 * The hard-link commit is same-directory, atomic, and refuses replacement.
 */
export async function publishNewFileAtomically(
  destination: string,
  contents: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  const directory = dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stagingPath = join(directory, `.${basename(destination)}-${randomUUID()}.pending`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(stagingPath, "wx", mode);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(stagingPath, destination);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(stagingPath).catch(() => undefined);
  }
}
