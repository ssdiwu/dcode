import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { DCodeDataRootError, resolveDCodeDataRoot } from "../src/dcode-data-root.js";

test("D Code data root defaults to the current user's .dcode directory", () => {
  const layout = resolveDCodeDataRoot(undefined, "/Users/tester");
  assert.equal(layout.root, "/Users/tester/.dcode");
  assert.equal(layout.productStorePath, "/Users/tester/.dcode/product-store.sqlite3");
  assert.equal(layout.productStoreLeasePath, "/Users/tester/.dcode/runtime/product-store.lock");
  assert.equal(layout.artifactsDirectory, "/Users/tester/.dcode/artifacts");
});

test("D Code data root accepts an explicit absolute test root", () => {
  const layout = resolveDCodeDataRoot("/tmp/dcode-test-root/.dcode", "/Users/tester");
  assert.equal(layout.root, "/tmp/dcode-test-root/.dcode");
  assert.equal(layout.migrationsDirectory, join(layout.root, "migrations"));
});

test("D Code data root rejects relative and filesystem-root targets", () => {
  for (const candidate of [".dcode", "relative/path", "/", "/tmp/unrelated-directory"]) {
    assert.throws(
      () => resolveDCodeDataRoot(candidate, "/Users/tester"),
      (error: unknown) => error instanceof DCodeDataRootError
        && error.code === "INVALID_DCODE_DATA_ROOT",
    );
  }
});

test("D Code data root requires an absolute user home", () => {
  assert.throws(
    () => resolveDCodeDataRoot(undefined, "relative-home"),
    (error: unknown) => error instanceof DCodeDataRootError,
  );
});
