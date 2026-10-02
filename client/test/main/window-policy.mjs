import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import electron from "electron";
import { createServer } from "vite";

const client = fileURLToPath(new URL("../../", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "dcode-window-policy-"));
const expectedVersion = JSON.parse(await readFile(join(client, "package.json"), "utf8")).version;
const policy = html => html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/i)?.[1];
let vite;
try {
  const productionHtml = await readFile(join(client, "dist/renderer/index.html"), "utf8");
  const productionCsp = policy(productionHtml);
  assert.ok(productionCsp, "built renderer must have a CSP");
  assert.match(productionCsp, /connect-src 'self';/);
  assert.doesNotMatch(productionCsp, /ws:\/\/127\.0\.0\.1:\*/);
  assert.doesNotMatch(productionCsp, /ws:\/\//);

  vite = await createServer({ configFile: join(client, "vite.config.ts"), logLevel: "silent" });
  await vite.listen();
  const address = vite.httpServer?.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  const devHtml = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const developmentCsp = policy(devHtml);
  assert.ok(developmentCsp, "development renderer must have a CSP");
  assert.match(developmentCsp, new RegExp(`connect-src 'self' ws:\\/\\/127\\.0\\.0\\.1:${port};`));
  assert.doesNotMatch(developmentCsp, /ws:\/\/127\.0\.0\.1:\*/);
  const viteClient = await (await fetch(`http://127.0.0.1:${port}/@vite/client`)).text();
  const wsToken = viteClient.match(/const wsToken = "([^"]+)";/)?.[1];
  assert.ok(wsToken, "Vite HMR token must be available");

  await mkdir(join(temp, "agent"));
  await writeFile(join(temp, "agent/settings.json"), "{}\n");
  await writeFile(join(temp, "foreign.html"), "<!doctype html><title>Foreign window</title>");
  const runner = join(temp, "runner.cjs");
  await writeFile(runner, `
const { app, BrowserWindow } = require('electron');
const { writeFile } = require('node:fs/promises');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const temp = ${JSON.stringify(temp)};
const productionCsp = ${JSON.stringify(productionCsp)};
const developmentCsp = ${JSON.stringify(developmentCsp)};
const port = ${JSON.stringify(port)};
const wsToken = ${JSON.stringify(wsToken)};
const expectedVersion = ${JSON.stringify(expectedVersion)};
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.focus = function () {};
let mainWindowSeen = false;
app.on('browser-window-created', (_event, mainWindow) => {
  if (mainWindowSeen) return;
  mainWindowSeen = true;
  mainWindow.webContents.once('did-finish-load', async () => {
    let foreign;
    try {
      const run = code => mainWindow.webContents.executeJavaScript(code, true);
      const state = name => run('navigator.permissions.query({name:' + JSON.stringify(name) + '}).then(result=>result.state)');
      assert.equal(await state('geolocation'), 'denied');
      assert.equal(await state('notifications'), 'denied');
      assert.equal(await state('clipboard-read'), 'denied');
      assert.equal(await state('clipboard-write'), 'granted');
      assert.equal(await run('Notification.requestPermission()'), 'denied');
      assert.equal((await run('window.dcode.diagnostics()')).version, expectedVersion);

      foreign = new BrowserWindow({show:false, webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
      await foreign.loadFile(join(temp, 'foreign.html'));
      assert.equal(await foreign.webContents.executeJavaScript('navigator.permissions.query({name:"clipboard-write"}).then(result=>result.state)'), 'denied');

      const socket = async (csp, url) => {
        await foreign.loadURL(url ?? 'data:text/html,' + encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="' + csp + '">'));
        return foreign.webContents.executeJavaScript('new Promise(resolve => { let violation; addEventListener("securitypolicyviolation", event => { violation = event.blockedURI + " / " + event.violatedDirective; }); const ws = new WebSocket("ws://127.0.0.1:${port}/?token=${wsToken}", "vite-hmr"); const timer = setTimeout(() => resolve({state:"timeout",violation}), 5000); ws.onopen = () => { clearTimeout(timer); ws.close(); resolve({state:"open",violation}); }; ws.onerror = () => { clearTimeout(timer); setTimeout(() => resolve({state:"blocked",violation}), 50); }; })');
      };
      const productionSocket = await socket(productionCsp);
      const developmentSocket = await socket(developmentCsp, 'http://127.0.0.1:${port}/');
      assert.equal(productionSocket.state, 'blocked');
      assert.equal(developmentSocket.state, 'open', JSON.stringify({productionSocket,developmentSocket}));
      await writeFile(join(temp, 'result.json'), JSON.stringify({passed:true,permissions:['geolocation','notifications','clipboard-read'],clipboardWrite:'trusted-main-only',productionWebSocket:'blocked',developmentHmrWebSocket:'open'}));
    } catch (error) {
      await writeFile(join(temp, 'result.json'), JSON.stringify({passed:false,error:String(error),stack:error.stack}));
    } finally {
      foreign?.destroy();
      mainWindow.destroy();
      app.quit();
    }
  });
});
import(${JSON.stringify(pathToFileURL(join(client, "dist/src/main/index.js")).href)});
`);
  const env = {
    ...process.env,
    DCODE_DATA_ROOT: join(temp, ".dcode"),
    DCODE_AGENT_DIR: join(temp, "agent"),
    DCODE_USER_DATA: join(temp, "profile"),
    PI_OFFLINE: "1",
  };
  for (const key of ["ELECTRON_RUN_AS_NODE", "DCODE_RENDERER_URL", "DCODE_CAPTURE", "DCODE_HOST_ENTRY", "DCODE_SWITCH_ID", "DCODE_SWITCH_READY"]) delete env[key];
  const { stderr } = await promisify(execFile)(electron, [runner], { cwd: client, env, timeout: 90_000, maxBuffer: 2_000_000 });
  const result = JSON.parse(await readFile(join(temp, "result.json"), "utf8"));
  assert.equal(result.passed, true, `${result.stack ?? result.error}\n${stderr}`);
  console.log(JSON.stringify(result));
} finally {
  await vite?.close();
  await rm(temp, { recursive: true, force: true });
}
