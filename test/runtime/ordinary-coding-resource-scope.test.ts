import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCodingInstructions, loadCodingResources, CodingResourcesUnavailable } from '../../src/adapters/pi/index.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dcode-resource-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); const app = join(root, 'app');
  await mkdir(project); await mkdir(app);
  await writeFile(join(root, 'AGENTS.md'), 'PARENT_OUTSIDE_RESOURCE_CANARY');
  return { root, project, app };
}

await test('自动项目资源只读显式项目和应用目录，不枚举祖先指令', async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, 'AGENTS.md'), 'OWN_PROJECT_RESOURCE_CANARY');
  await writeFile(join(f.app, 'AGENTS.md'), 'OWN_APP_RESOURCE_CANARY');
  const skills = join(f.project, '.pi/skills/valid'); await mkdir(skills, { recursive: true });
  await writeFile(join(skills, 'SKILL.md'), '---\nname: valid\ndescription: OWN_SKILL_RESOURCE_CANARY\n---\nbody');
  const instructions = await loadCodingInstructions(f.project, f.app);
  assert.equal(instructions.includes('OWN_PROJECT_RESOURCE_CANARY'), true);
  assert.equal(instructions.includes('OWN_APP_RESOURCE_CANARY'), true);
  assert.equal(instructions.includes('OWN_SKILL_RESOURCE_CANARY'), true);
  assert.equal(instructions.includes('PARENT_OUTSIDE_RESOURCE_CANARY'), false, '任务目录之外的祖先不是自动读取授权');
});

for (const kind of ['skill-directory', 'skill-file'] as const) await test(`越界技能候选 ${kind} 不读取该条目，也不拖垮整个工作目录`, async t => {
  const f = await fixture(t); const outside = join(f.root, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'SKILL.md'), '---\nname: outside\ndescription: OUTSIDE_RESOURCE_CANARY\n---\nbody');
  const skills = join(f.project, '.pi/skills'); await mkdir(skills, { recursive: true });
  if (kind === 'skill-directory') await symlink(outside, join(skills, 'escape'));
  else await symlink(join(outside, 'SKILL.md'), join(skills, 'SKILL.md'));
  const resources = await loadCodingResources(f.project, f.app);
  assert.equal(resources.instructions.includes('OUTSIDE_RESOURCE_CANARY'), false, '越界资源没有被读取');
  assert.ok((resources.skippedOutOfScope ?? 0) >= 1, '越界条目如实报出');
});

await test('越界资源符号链接 project-instructions 在读取前拒绝', async t => {
  const f = await fixture(t); const outside = join(f.root, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'SKILL.md'), '---\nname: outside\ndescription: OUTSIDE_RESOURCE_CANARY\n---\nbody');
  await symlink(join(outside, 'SKILL.md'), join(f.project, 'AGENTS.md'));
  await assert.rejects(loadCodingInstructions(f.project, f.app), CodingResourcesUnavailable);
});

await test('自动发现但未纳入的技能跳过并如实报出，不冒称资源已就绪', async t => {
  const f = await fixture(t); const skills = join(f.project, '.agents/skills/broken');
  await mkdir(skills, { recursive: true });
  await writeFile(join(skills, 'SKILL.md'), '---\nname: missing-description\n---\nbody');
  const resources = await loadCodingResources(f.project, f.app);
  assert.equal(resources.instructions.includes('missing-description'), false, '未纳入的技能没有进入指令');
  assert.ok(resources.unavailableNames?.some(name => name.includes('broken')), '未纳入的技能如实报出');
});

await test('家目录工作空间：越界链接与同名碰撞不阻断工作目录，正常技能照常可用', async t => {
  const f = await fixture(t);
  const home = join(f.root, 'home'); await mkdir(home, { recursive: true });
  const skills = join(home, '.agents/skills'); await mkdir(skills, { recursive: true });
  const outside = join(f.root, 'outside-home'); await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'SKILL.md'), '---\nname: outside-home\ndescription: HOME_OUTSIDE_CANARY\n---\nbody');
  // 家目录里真实存在的两种坏条目：指向目录外的链接，以及同一技能名的重复副本。
  await symlink(outside, join(skills, 'ego-browser'));
  const nested = join(skills, 'plugin'); await mkdir(nested, { recursive: true });
  await mkdir(join(nested, 'good'), { recursive: true });
  await writeFile(join(nested, 'good', 'SKILL.md'), '---\nname: good\ndescription: HOME_GOOD_CANARY\n---\nbody');
  const duplicate = join(skills, 'good'); await mkdir(duplicate, { recursive: true });
  await writeFile(join(duplicate, 'SKILL.md'), '---\nname: good\ndescription: HOME_GOOD_CANARY\n---\nbody');
  const resources = await loadCodingResources(home, f.app);
  assert.equal(resources.instructions.includes('HOME_OUTSIDE_CANARY'), false, '越界技能没有被读取');
  assert.equal(resources.instructions.includes('HOME_GOOD_CANARY'), true, '正常技能照常进入指令');
  assert.ok((resources.skippedOutOfScope ?? 0) >= 1, '越界条目如实报出');
  assert.ok(resources.unavailableNames?.some(name => name.includes('good')), '同名碰撞取舍如实报出');
});

for (const kind of ['skill', 'instructions'] as const) await test(`已存在的断链 ${kind} 不能当作可选资源缺席`, async t => {
  const f = await fixture(t);
  if (kind === 'skill') {
    const dir = join(f.project, '.pi/skills'); await mkdir(dir, { recursive: true });
    await symlink(join(f.project, 'missing-skill'), join(dir, 'SKILL.md'));
  } else await symlink(join(f.project, 'missing-instructions'), join(f.project, 'AGENTS.md'));
  await assert.rejects(loadCodingInstructions(f.project, f.app), CodingResourcesUnavailable);
});

for (const kind of ['outside-link', 'broken-link', 'malformed', 'invalid-utf8'] as const) await test(`模板声明 ${kind} 不能越界读取或静默丢项`, async t => {
  const f = await fixture(t); const prompts = join(f.project, '.pi/prompts'); await mkdir(prompts, { recursive: true });
  const file = join(prompts, 'repair.md');
  if (kind === 'outside-link') {
    const outside = join(f.root, 'outside-prompt.md'); await writeFile(outside, 'OUTSIDE_TEMPLATE_CANARY'); await symlink(outside, file);
  } else if (kind === 'broken-link') await symlink(join(f.project, 'missing-prompt.md'), file);
  else if (kind === 'malformed') await writeFile(file, '---\nbroken: [\n---\nbody');
  else await writeFile(file, Buffer.from([0xff, 0xfe]));
  await assert.rejects(loadCodingResources(f.project, f.app), CodingResourcesUnavailable);
});
