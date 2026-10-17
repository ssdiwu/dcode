import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, copyFile, realpath, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';

const sourceRoot = resolve('.');
const sourceLauncher = join(sourceRoot, 'tools/launch-desktop.py');
const sourceWrapper = join(sourceRoot, '启动 D Code.command');
const packageInfo = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('固定桌面入口透传 --check；npm、shell wrapper 与 launcher 都只验证隔离假根', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dcode-desktop-entry-check-')));
  try {
    const tools = join(root, 'tools'), home = join(root, 'home');
    await mkdir(tools, { recursive: true }); await mkdir(home);
    await copyFile(sourceLauncher, join(tools, 'launch-desktop.py'));
    await copyFile(sourceWrapper, join(root, '启动 D Code.command'));
    assert.match(await readFile(sourceWrapper, 'utf8'), /launch-desktop\.py"\s+"\$@"/);
    await mkdir(join(root, 'out/main'), { recursive: true });
    await mkdir(join(root, 'resources/brand'), { recursive: true });
    await mkdir(join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS'), { recursive: true });
    await writeFile(join(root, 'out/main/index.js'), '// isolated launcher fixture');
    await writeFile(join(root, 'resources/brand/dcode-owl-master.png'), 'isolated brand fixture');
    const fakeElectron = join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
    await writeFile(fakeElectron, `#!/bin/sh\nprintf launched > "$HOME/electron-launch-marker"\n`);
    await chmod(fakeElectron, 0o755);
    const fakePackage = {
      name: 'isolated-desktop-entry-test', version: packageInfo.version, type: 'module',
      scripts: { desktop: 'python3 tools/launch-desktop.py', build: `python3 -c "from pathlib import Path; Path('build-marker').write_text('built')"` },
    };
    await writeFile(join(root, 'package.json'), JSON.stringify(fakePackage));
    const env = { ...process.env, HOME: home };
    for (const entry of [
      run('/usr/bin/python3', [join(tools, 'launch-desktop.py'), '--check'], root, env),
      run('/bin/zsh', [join(root, '启动 D Code.command'), '--check'], root, env),
      run('npm', ['run', 'desktop', '--', '--check'], root, env),
    ]) {
      assert.equal(entry.version, packageInfo.version);
      assert.equal(entry.source, root);
      assert.equal(entry.entry_exists, true);
      assert.equal(entry.brand_exists, true);
      assert.equal(entry.state_directory, join(home, 'Library/Application Support/D Code Development'));
    }
    await assert.rejects(readFile(join(root, 'build-marker')), { code: 'ENOENT' }, '安全检查不得调用构建');
    await assert.rejects(readFile(join(home, 'electron-launch-marker')), { code: 'ENOENT' }, '隔离 Electron 哨兵不得启动');
    await assert.rejects(readFile(join(home, 'Library/Application Support/D Code Development/launch.lock')), { code: 'ENOENT' }, '检查不得创建状态目录');
    await assert.rejects(access(join(home, 'Library/Application Support/D Code Development/userdata')), { code: 'ENOENT' }, '检查不得创建 Electron profile');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('普通 launcher 在 Electron 启动前准备隔离的 userData 子目录', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dcode-desktop-entry-start-')));
  try {
    const tools = join(root, 'tools'), home = join(root, 'home');
    await mkdir(tools, { recursive: true }); await mkdir(home);
    await copyFile(sourceLauncher, join(tools, 'launch-desktop.py'));
    await mkdir(join(root, 'out/main'), { recursive: true });
    await writeFile(join(root, 'out/main/index.js'), '// isolated launcher fixture');
    const fakeElectron = join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
    await mkdir(dirname(fakeElectron), { recursive: true });
    await writeFile(fakeElectron, [
      '#!/bin/sh',
      'set -eu',
      'if [ -d "$DCODE_STATE_DIR/userdata" ]; then profile=exists; else profile=missing; fi',
      'printf "%s\\n%s\\n%s\\n%s\\n" "$DCODE_STATE_DIR" "$HOME" "$profile" "$1" > "$HOME/electron-launch-marker"',
    ].join('\n'));
    await chmod(fakeElectron, 0o755);
    const fakePackage = {
      name: 'isolated-desktop-entry-start-test', version: packageInfo.version, type: 'module',
      scripts: { desktop: 'python3 tools/launch-desktop.py', build: 'touch build-marker' },
    };
    await writeFile(join(root, 'package.json'), JSON.stringify(fakePackage));
    const result = spawnSync('/usr/bin/python3', [join(tools, 'launch-desktop.py')], {
      cwd: root, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const marker = join(home, 'electron-launch-marker');
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try { await access(marker); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    const state = join(home, 'Library/Application Support/D Code Development');
    assert.deepEqual((await readFile(marker, 'utf8')).trim().split('\n'), [state, home, 'exists', `--user-data-dir=${join(state, 'userdata')}`]);
    await access(join(root, 'build-marker'));
    const record = JSON.parse(await readFile(join(state, 'desktop-process.json'), 'utf8'));
    assert.equal(record.source, root);

    const deadlineExit = Date.now() + 2_000;
    let stillAlive = true;
    while (Date.now() < deadlineExit) {
      const processCheck = spawnSync('/bin/ps', ['-p', String(record.pid), '-o', 'command='], { encoding: 'utf8' });
      stillAlive = processCheck.status === 0 && processCheck.stdout.includes(fakeElectron);
      if (!stillAlive) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(stillAlive, false, 'fake Electron child exits before its fixture root is removed');
  } finally { await rm(root, { recursive: true, force: true }); }
});
