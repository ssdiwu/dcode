// server-only dev 取证：用同源已装 Vite（v7）createServer API 起 renderer 静态服务，
// 通过 HTTP 拉同源资源字节并与母版 SHA 对比；不启动 Electron/可见窗口；finally await server.close()；
// 关闭后用 HTTP 验证服务已真实关闭（仅 ECONNREFUSED 才是"关闭"事实；其余错误重新抛）。
// 项目根从脚本自身位置向上2层（tools/diagnostics/ 子级），不硬编码本机路径，复制到主树集成后同结构可用。
import { createServer } from "vite";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";

// tools/diagnostics → tools → ROOT（实际两级）
const ROOT = join(import.meta.dirname, "../..");
const EVID = join(ROOT, "doc/验证记录/品牌猫头鹰-2026-10-08/evidence");
mkdirSync(EVID, { recursive: true });
const MASTER = join(ROOT, "resources/brand/dcode-owl-master.png");
const masterBytes = readFileSync(MASTER);
const masterSha = createHash("sha256").update(masterBytes).digest("hex");

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), contentType: res.headers["content-type"] }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
  });
}

const record = { masterSha256: masterSha, pid: process.pid, probes: [] };
let server = null;
try {
  // server.port=0 请求 OS 分配可用端口；Vite 7 默认可用端口 5173。实例归属用 server.resolvedUrls.local[0]
  // 返回的本次实际地址，不靠端口名句定，不在工具内自证关闭——关闭后 PID 复核由外层。
  server = await createServer({
    root: join(ROOT, "src/renderer"),
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "warn",
  });
  await server.listen();
  const base = server.resolvedUrls.local[0].replace(/\/$/, "");
  record.actualBase = base;
  record.pid = process.pid;

  const candidates = [
    "/assets/dcode-owl.png",
    "/@fs" + join(ROOT, "src/renderer/assets/dcode-owl.png"),
    "/src/renderer/assets/dcode-owl.png",
  ];
  let matched = null;
  for (const c of candidates) {
    let r = null;
    try { r = await get(base + c); } catch (err) { record.probes.push({ url: base + c, error: String(err.message ?? err) }); continue; }
    const sha = createHash("sha256").update(r.body).digest("hex");
    record.probes.push({ url: base + c, httpStatus: r.status, bodyBytes: r.body.length, sha256: sha, matchesMaster: sha === masterSha });
    if (r.status === 200 && sha === masterSha) { matched = record.probes[record.probes.length - 1]; break; }
  }
  if (!matched) throw new Error("dev 服务下未拉到与母版 SHA 相同的字节");
  record.matched = matched;
  console.log("base:", base, "matched:", matched.url, "bytes:", matched.bodyBytes);
} finally {
  if (server) await server.close();
  // close 后必须以明确 ECONNREFUSED 才证明关闭；其余错误（timeout、其他代码）重新抛出，不得吞为成功
  record.closeVerified = { pid: record.pid, note: "本进程是同 node 主线程；服务关闭由 HTTP 层验证（只有明确连接拒绝才算关闭成功）" };
  try {
    const probe = await get(record.actualBase + "/assets/dcode-owl.png");
    record.closeVerified.httpAlive = { status: probe.status, note: "close 后服务仍在接受连接（异常）" };
    throw new Error("server.close() 后服务仍能连接——归属未清: " + JSON.stringify(record.closeVerified));
  } catch (err) {
    const code = err?.code ?? err?.cause?.code ?? null;
    if (code === "ECONNREFUSED") {
      record.closeVerified.httpAlive = { code: "ECONNREFUSED", note: "服务已真实关闭" };
    } else {
      // timeout 或其他错误不证明关闭——重新抛出
      throw err;
    }
  }
  writeFileSync(join(EVID, "brand-dev-server-http.json"), JSON.stringify(record, null, 1));
}
