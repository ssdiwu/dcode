// 专项离线兼容验证；输入必须是旧 1.0 SDK 实际生成的隔离记录，不在此用新 SDK 伪造历史。
// 不属于 test:runtime 的默认通配；调用与公开旧记录来源见 doc/Pi版本与升级.md。
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRegistry, defineExtension, defineTask, defineTool } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { Type } from '@earendil-works/pi-ai';
import { PiExecutionSession } from '../../src/adapters/pi/index.ts';
import { controlledModels, until } from '../runtime/fixtures.ts';

const [legacyManifest, completingManifest, factsFile] = process.argv.slice(2);
if (!legacyManifest || !completingManifest || !factsFile) throw new Error('Expected legacy manifest, completing manifest and new facts output path');
const legacy = JSON.parse(await readFile(legacyManifest, 'utf8'));
const completing = JSON.parse(await readFile(completingManifest, 'utf8'));
assert.equal(legacy.sdkVersion, '1.0.0'); assert.equal(completing.producerSdk, '1.0.0');
assert.equal(completing.oldRecord.version, 1); assert.equal(completing.oldRecord.input.kind, undefined);
assert.equal(completing.oldRecord.state.status, 'completing'); assert.equal(completing.oldRecord.state.outcome.result.kind, undefined);
const root = await mkdtemp(join(tmpdir(), 'dcode-pi100-readonly-upgrade-'));
const facts = [];
const sourceHashes = async directory => Object.fromEntries(await Promise.all((await readdir(directory)).filter(name => name.endsWith('.jsonl')).sort().map(async name => [name, createHash('sha256').update(await readFile(join(directory, name))).digest('hex')])));
try {
  const records = [...legacy.records, { ...completing, mode: 'completing', target: completing.request.target, before: { entries: [] }, effect: 'once\n' }];
  for (const old of records) {
    const directory = join(root, old.mode); await cp(old.directory, directory, { recursive: true });
    const f = controlledModels(); const registry = createRegistry(); registry.install(CodingTools);
    let newToolCalls = 0; let childResumes = 0;
    const child = defineTask({ name: 'legacy.completion-child', version: 1, initial: () => ({ phase: 'run' }), phases: {
      run: async (_task, runtime, context) => { childResumes++; await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context); },
    }, abort: async (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context) });
    registry.install(defineExtension({ name: 'legacy-migration-tripwire', tasks: [child], tools: ['legacy_interruption', 'legacy_completion'].map(name => defineTool({
      name, description: 'Old unsafe invocation must never execute on upgrade', parameters: Type.Object({}), replay: 'unsafe',
      execute: async () => { newToolCalls++; throw new Error('Legacy unsafe tool was replayed'); },
    })) }));
    const sourceBefore = await sourceHashes(old.directory);
    const effectPath = join(old.cwd, old.mode === 'completing' ? 'completing-count.txt' : 'legacy-effect.txt');
    const originalEffect = await readFile(effectPath, 'utf8');
    const unit = await PiExecutionSession.open({ directory, initialize: false, cwd: old.cwd, target: old.target, models: f.models, registry,
      agent: { model: { provider: f.model.provider, modelId: f.model.id } }, env: agent => new NodeExecutionEnv({ cwd: agent.cwd ?? old.cwd }),
    });
    try {
      const view = await unit.read(); const receipt = await unit.lookupReceipt(old.request);
      assert.equal(receipt.status, 'accepted'); assert.equal(receipt.submissionId, old.receipt?.submissionId ?? 9);
      if (old.mode === 'completed') assert.equal(receipt.processing, 'done');
      for (const entry of old.before.entries) {
        const restored = view.entries.find(item => item.id === entry.id);
        assert.deepEqual(JSON.parse(JSON.stringify(restored)), entry, '按旧fixture保存的JSON边界核原正式条目身份和正文；不把undefined键的省略当数据迁移');
      }
      assert.equal(f.requests.length, 0); assert.equal(newToolCalls, 0); assert.equal(childResumes, 0);
      assert.equal(await readFile(effectPath, 'utf8'), originalEffect);
      if (old.mode !== 'completed') {
        assert.equal(view.phase, 'paused'); await unit.resume(view.control); await until(() => f.requests.length === 1);
        if (old.mode === 'paused-model') assert.match(JSON.stringify(f.requests[0].messages), /legacy-bash-call/);
        if (old.mode === 'paused-unsafe-tool') assert.match(JSON.stringify(f.requests[0].messages), /interrupted/i);
        if (old.mode === 'completing') { assert.match(JSON.stringify(f.requests[0].messages), /legacy completion result exact nonce/); assert.equal(childResumes, 1); }
        f.requests[0].finish([{ type: 'text', text: 'new1.3 exact continuation ' + old.mode }]);
        await until(async () => { const r = await unit.lookupReceipt(old.request); return r.status === 'accepted' && r.processing === 'done'; });
      }
      assert.equal(newToolCalls, 0); assert.equal(await readFile(effectPath, 'utf8'), originalEffect);
      assert.deepEqual(await sourceHashes(old.directory), sourceBefore, '只在旧数据副本运行，原冻结日志逐字保留');
      facts.push({ mode: old.mode, originalSubmissionId: receipt.submissionId, readonlyRequests: 0, readonlyToolCalls: 0, requestsAfterExplicitResume: f.requests.length,
        newUnsafeToolCalls: newToolCalls, childResumes, effectPreserved: true, originalLogsUnchanged: true });
    } finally { await unit.close(); }
  }
  await writeFile(factsFile, JSON.stringify({ sourceSdk: '1.0.0', targetSdk: '1.3.0', legacyManifest, completingManifest, cases: facts, wholeProductAcceptance: false }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: facts.length, cases: facts }));
} finally { await rm(root, { recursive: true, force: true }); }
