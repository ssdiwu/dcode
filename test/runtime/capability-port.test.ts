// D 片装配集合：能力资料与**实际能请求**的模型集合必须是同一份事实。
//
// 这里覆盖的是「有效线上新 ID」：它登记得进目录、也能真的发请求，
// 但内置 `getModels()` 里没有这一条。只查内置就取不到能力资料，
// 于是按「查不到」处理——把一个可执行的模型判成不具备能力依据。

import test from 'node:test';
import assert from 'node:assert/strict';
import { PiCapabilityPort } from '../../src/adapters/pi/capability-port.ts';
import type { RegisteredPresetProvider } from '../../src/adapters/pi/preset-providers.ts';
import type { Model } from '@earendil-works/pi-ai';
import type { Api } from '@earendil-works/pi-ai';

const ANCHOR: Model<Api> = {
  id: 'online-new-model',
  name: '线上新模型',
  api: 'anthropic-messages',
  provider: 'acme',
  baseUrl: 'https://api.acme.test',
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_000,
  reasoning: true,
} as unknown as Model<Api>;

const builtin = { id: 'builtin-model', name: '内置模型' } as unknown as Model<Api>;

const preset = {
  id: 'acme',
  name: 'Acme',
  provider: { getModels: () => [builtin] } as unknown as RegisteredPresetProvider["provider"],
} as unknown as RegisteredPresetProvider;

const identity = { sourceId: 'acme', modelId: 'online-new-model' };

void test('有效线上新 ID：能力资料按当次解析给出，不因内置目录没有就判成查不到', async () => {
  const port = new PiCapabilityPort({
    presets: [preset],
    configuredCandidates: () => true,
    // 当次有效解析：执行端能请求它，能力事实按同一份解析给
    effectiveModel: (input) => (input.modelId === 'online-new-model' ? ANCHOR : null),
    effectiveLabel: (input) => (input.modelId === 'online-new-model' ? '线上新模型' : null),
  });
  const read = await port.read(identity, ['image-input']);
  assert.ok(read, '已生效的线上新 ID 必须有可核对的能力资料，不能只查内置就返回查不到');
  assert.equal(read!.identity.modelLabel, '线上新模型', '显示名取目录资料');
  assert.equal(read!.contextWindow, 200_000, '上下文上限取同一份解析结果');
  assert.deepEqual([...read!.input].sort(), ['image', 'text']);
  assert.equal(read!.supports['image-input'].supported, true, '逐项能力按同一份解析判定');
  assert.equal(read!.supports['image-input'].evidence, 'catalog');
});

void test('内置目录里确实有的模型仍走内置资料，不被当次解析覆盖成另一份', async () => {
  const port = new PiCapabilityPort({
    presets: [preset],
    configuredCandidates: () => true,
    effectiveModel: () => null,
    effectiveLabel: () => null,
  });
  const read = await port.read({ sourceId: 'acme', modelId: 'builtin-model' }, []);
  assert.ok(read, '内置条目照常可读');
  assert.equal(read!.identity.modelLabel, '内置模型');
  assert.equal(read!.contextWindow, null, '内置条目没有被伪造成带上下文的条目');
});

void test('两处都查不到时如实返回 null，不拿别的模型资料顶替', async () => {
  const port = new PiCapabilityPort({
    presets: [preset],
    configuredCandidates: () => true,
    effectiveModel: () => null,
    effectiveLabel: () => null,
  });
  assert.equal(await port.read({ sourceId: 'acme', modelId: 'never-heard-of-it' }, []), null);
});