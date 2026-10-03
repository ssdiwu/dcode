import fs from "node:fs";
import path from "node:path";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SOURCE = /\.(?:[cm]?[jt]sx?)$/u;
const slash = (value) => value.split(path.sep).join("/");
const within = (value, root) => value === root || value.startsWith(`${root}/`);
const localPath = (value) => typeof value === "string" && value.length > 0 && !path.isAbsolute(value)
  && slash(path.normalize(value)) === value && value !== ".." && !value.startsWith("../");
const matches = (value, pattern) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "u").test(value);
const packageName = (value) => value.startsWith("@") ? value.split("/").slice(0, 2).join("/") : value.split("/")[0];

function validatePolicy(policy) {
  if (policy.version !== 1 || !localPath(policy.sourceRoot) || !Array.isArray(policy.modules) || !policy.modules.length) {
    throw new Error("Expected policy version 1, sourceRoot and nonempty modules");
  }
  for (const key of ["excludedDirectories", "configurationFiles"]) {
    if (!Array.isArray(policy[key]) || !policy[key].every(localPath)) throw new Error(`Invalid ${key}`);
  }
  if (policy.excludedDirectories.some((dir) => within(policy.sourceRoot, dir) || within(dir, policy.sourceRoot))) {
    throw new Error("Product sourceRoot cannot overlap an excluded directory");
  }
  if (policy.configurationFiles.some((file) => file.includes("/") || within(file, policy.sourceRoot))) {
    throw new Error("Configuration exclusions must name root-level files, not product source");
  }
  const ids = new Set();
  for (const module of policy.modules) {
    if (!module.id || ids.has(module.id) || !localPath(module.root) || !within(module.root, policy.sourceRoot)) {
      throw new Error(`Invalid or duplicate module: ${module.id}`);
    }
    ids.add(module.id);
    if (!Array.isArray(module.entrypoints) || !module.entrypoints.length || !module.entrypoints.every(localPath)) {
      throw new Error(`Invalid public entrypoints: ${module.id}`);
    }
    for (const key of ["allows", "externals"]) {
      if (!Array.isArray(module[key]) || !module[key].every((item) => typeof item === "string" && item.length > 0 && item !== "*")) {
        throw new Error(`Invalid ${key}: ${module.id}`);
      }
    }
  }
  for (const module of policy.modules) {
    if (module.allows.some((id) => !ids.has(id) || id === module.id)) throw new Error(`Unknown/self dependency: ${module.id}`);
    if (policy.modules.some((other) => other !== module && (within(other.root, module.root) || within(module.root, other.root)))) {
      throw new Error(`Overlapping module roots: ${module.id}`);
    }
  }
}

function dependencies(source, report) {
  const result = [];
  const add = (node, argument) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
      result.push({ specifier: argument.text, line });
    } else report("DYNAMIC_IMPORT", line, "Module reference must be a string literal");
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node, node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      add(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const requireCall = ts.isIdentifier(expression) && expression.text === "require";
      const requireMember = ts.isPropertyAccessExpression(expression) && (expression.name.text === "require"
        || (expression.name.text === "resolve" && ts.isIdentifier(expression.expression) && expression.expression.text === "require"));
      const requireElement = ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)
        && expression.argumentExpression.text === "require";
      if (expression.kind === ts.SyntaxKind.ImportKeyword || requireCall || requireMember || requireElement) add(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function reportCycles(graph, report) {
  const visited = new Set();
  const active = new Set();
  const stack = [];
  const emitted = new Set();
  const walk = (file) => {
    if (active.has(file)) {
      const cycle = [...stack.slice(stack.indexOf(file)), file];
      const key = [...new Set(cycle)].sort().join("\0");
      if (!emitted.has(key)) {
        emitted.add(key);
        report("CYCLE", file, 1, cycle.join(" -> "));
      }
      return;
    }
    if (visited.has(file)) return;
    visited.add(file);
    active.add(file);
    stack.push(file);
    for (const next of graph.get(file) ?? []) walk(next);
    stack.pop();
    active.delete(file);
  };
  for (const file of graph.keys()) walk(file);
}

export function checkArchitecture(directory) {
  const root = fs.realpathSync(directory);
  const violations = [];
  const report = (rule, file, line, message) => violations.push({ rule, file, line, message });
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(path.join(root, "architecture-policy.json"), "utf8"));
    validatePolicy(policy);
  } catch (error) {
    report("POLICY", "architecture-policy.json", 1, error.message);
    return { files: 0, modules: [], violations };
  }
  const owner = (file) => policy.modules.find((module) => within(file, module.root));
  const excluded = (file) => file.split("/").some((part) => part === "node_modules" || part === ".git")
    || policy.excludedDirectories.some((dir) => within(file, dir)) || policy.configurationFiles.includes(file);
  const files = [];
  const collect = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(folder, entry.name);
      const relative = slash(path.relative(root, absolute));
      if (excluded(relative)) continue;
      if (entry.isSymbolicLink()) {
        // Source directory symlinks would otherwise silently disappear from the audited graph.
        if (within(relative, policy.sourceRoot) || SOURCE.test(relative) || fs.statSync(absolute).isDirectory()) {
          report("SOURCE_SYMLINK", relative, 1, "Use real source files; source symlinks are not audited");
        }
      } else if (entry.isDirectory()) collect(absolute);
      else if (SOURCE.test(relative)) files.push(relative);
    }
  };
  collect(root);
  let compilerOptions;
  try {
    const configFile = path.join(root, "tsconfig.json");
    const config = ts.readConfigFile(configFile, ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, " "));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const errors = parsed.errors.filter((error) => error.code !== 18003);
    if (errors.length) throw new Error(errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, " ")).join("; "));
    compilerOptions = parsed.options;
  } catch (error) {
    report("CONFIG", "tsconfig.json", 1, error.message);
    return { files: files.length, modules: [], violations };
  }
  const graph = new Map();
  const modules = new Set();
  for (const file of files) {
    const module = owner(file);
    if (!module) {
      report("UNMANAGED", file, 1, "Source file has no declared module");
      continue;
    }
    modules.add(module.id);
    const absolute = path.join(root, file);
    const source = ts.createSourceFile(absolute, fs.readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true);
    for (const error of source.parseDiagnostics) {
      report("SYNTAX", file, source.getLineAndCharacterOfPosition(error.start ?? 0).line + 1,
        ts.flattenDiagnosticMessageText(error.messageText, " "));
    }
    const edges = new Set();
    graph.set(file, edges);
    const fail = (rule, line, message) => report(rule, file, line, message);
    for (const { specifier, line } of dependencies(source, fail)) {
      if (path.isAbsolute(specifier)) {
        fail("ABSOLUTE_IMPORT", line, specifier);
        continue;
      }
      const builtin = isBuiltin(specifier);
      if (specifier.startsWith("node:") && !builtin) {
        fail("UNRESOLVED", line, `Unknown Node module: ${specifier}`);
        continue;
      }
      const resolved = builtin ? undefined : ts.resolveModuleName(specifier, absolute, compilerOptions, ts.sys).resolvedModule;
      const relativeImport = specifier.startsWith(".");
      const alias = Object.keys(compilerOptions.paths ?? {}).some((pattern) => matches(specifier, pattern));
      let target = resolved && !resolved.isExternalLibraryImport ? resolved.resolvedFileName : undefined;
      if (!target && relativeImport) {
        const asset = path.resolve(path.dirname(absolute), specifier);
        if (fs.existsSync(asset) && fs.statSync(asset).isFile()) target = asset;
      }
      if (target) {
        target = fs.realpathSync(target);
        const targetFile = slash(path.relative(root, target));
        if (!localPath(targetFile)) {
          fail("OUTSIDE_ROOT", line, specifier);
          continue;
        }
        const targetModule = owner(targetFile);
        if (excluded(targetFile) || !targetModule) {
          fail("UNMANAGED_IMPORT", line, targetFile);
          continue;
        }
        if (targetModule.id !== module.id) {
          if (!module.allows.includes(targetModule.id)) fail("DIRECTION", line, `${module.id} -> ${targetModule.id}`);
          const publicPaths = targetModule.entrypoints.map((entry) => `${targetModule.root}/${entry}`);
          if (!publicPaths.includes(targetFile)) fail("PRIVATE_IMPORT", line, targetFile);
        }
        if (SOURCE.test(targetFile)) edges.add(targetFile);
      } else if (relativeImport || alias || specifier.startsWith("#")) {
        fail("UNRESOLVED", line, specifier);
      } else {
        const dependency = builtin ? `node:${specifier.replace(/^node:/u, "")}` : packageName(specifier);
        if (!module.externals.some((pattern) => matches(dependency, pattern))) fail("EXTERNAL", line, dependency);
      }
    }
  }
  reportCycles(graph, report);
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
  return { files: files.length, modules: [...modules].sort(), violations };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length) throw new Error("Run from the repository root; no scope-narrowing command options are supported");
  const result = checkArchitecture(process.cwd());
  console.log(`Architecture: ${result.violations.length ? "FAILED" : "PASS"}; source files: ${result.files}; modules: ${result.modules.join(", ") || "none"}`);
  if (result.files === 0) console.log("No product source yet. This result is not an application architecture or behavior acceptance.");
  for (const item of result.violations) console.error(`${item.file}:${item.line} [${item.rule}] ${item.message}`);
  process.exitCode = result.violations.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`Architecture check failed: ${error.message}`); process.exitCode = 1; }
}
