import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRegistry } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { PiExecutionSession } from '../src/adapters/pi/index.ts';
import { controlledModels, until } from '../test/runtime/fixtures.ts';

const directory = await mkdtemp(join(tmpdir(), 'dcode-pi-demo-'));
const fixture = controlledModels();
const registry = createRegistry(); registry.install(CodingTools);
const options = { target: { workspaceId: 'demo-space', taskId: 'demo-task', sessionId: 'demo-session' }, directory: join(directory, 'records'), cwd: directory, models: fixture.models, registry, agent: { model: { provider: fixture.model.provider, modelId: fixture.model.id } }, env: target => new NodeExecutionEnv({ cwd: target.cwd }) };
let unit;
try {
  console.log('执行：真实 Pi Durable 1.0.0；模型：本地受控模型；数据：自动清理的隔离目录。');
  unit = await PiExecutionSession.open(options);
  const input = { target: options.target, operationId: 'write-file', text: '在隔离目录写入一个文件', mode: 'steer', expected: (await unit.read()).control };
  const receipt = await unit.submit(input); console.log('输入回执：', receipt);
  await until(() => fixture.requests.length === 1);
  fixture.requests[0].finish([{ type: 'toolCall', id: 'write-file', name: 'write', arguments: { path: join(directory, 'result.txt'), content: 'This file was written by a real Pi tool.' } }], 'toolUse');
  await until(() => fixture.requests.length === 2);
  console.log('实际文件读回：', await readFile(join(directory, 'result.txt'), 'utf8'));
  const paused = await unit.pause(); console.log('暂停完成：', paused.phase);
  await unit.close(); unit = await PiExecutionSession.open(options);
  console.log('重开查询：', (await unit.read()).phase, '模型调用数：', fixture.requests.length);
  console.log('原输入仍可回查：', await unit.lookupReceipt(input));
  await unit.resume((await unit.read()).control); await until(() => fixture.requests.length === 3);
  fixture.requests[2].finish([{ type: 'text', text: '已从保存的真实工具结果继续。' }]);
  await until(async () => { const result = await unit.lookupReceipt(input); return result.status === 'accepted' && result.processing === 'done'; });
  console.log('显式继续后的结果：', await unit.lookupReceipt(input));
  console.log('真实历史条目数：', (await unit.read()).entries.length);
} finally {
  await unit?.close();
  await rm(directory, { recursive: true, force: true });
}
