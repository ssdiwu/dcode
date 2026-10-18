// 普通扩展上下文用量消费者，原SDK／工具／HTTP与生命周期。
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareCodingProject, startCodingLoopback } from './ordinary-coding-fixture.mjs';

export const contextUsageIds = Object.freeze({
  tool: 'extension_context_usage', contextWindow: 128000,
  trace: 'context-usage-events.jsonl', calls: ['actual-tool-1', 'actual-tool-2'],
});

export function contextUsageExtensionSource(nonce, project) {
  return `import { Type } from 'typebox';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
const nonce=${JSON.stringify(nonce)}, traceName=${JSON.stringify(contextUsageIds.trace)};
const snapshot=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const write=(cwd,value)=>appendFile(join(cwd,traceName),JSON.stringify({nonce,...value})+'\\n');
function observe(ctx){
  const first=ctx.getContextUsage();
  const synchronous=first!==undefined&&typeof first?.then!=='function';
  const before=snapshot(first);
  let mutation='no-value';
  if(first&&typeof first==='object'){
    try{first.tokens=-701;first.contextWindow=-702;first.percent=-703;first.extra='not-a-contract-field';mutation='attempted';}
    catch(error){mutation=error?.name??'mutation-rejected';}
  }
  const second=ctx.getContextUsage();
  return {synchronous,before,second:snapshot(second),differentObject:first!==second,
    mutation,model:ctx.model?{provider:ctx.model.provider,id:ctx.model.id,contextWindow:ctx.model.contextWindow}:null};
}
export default async function(pi){
  // 此副作用只辨认扩展真实加载，不作为正式产品运行／费用事实。
  await write(${JSON.stringify(project)},{kind:'extension-loaded'});
  pi.on('tool_call',async(event,ctx)=>{
    if(event.toolName!==${JSON.stringify(contextUsageIds.tool)})return;
    const observed=observe(ctx);
    await write(ctx.cwd,{kind:'event-observed',toolCallId:event.toolCallId,observed});
  });
  pi.registerTool({name:${JSON.stringify(contextUsageIds.tool)},label:'context usage',description:'Read current context usage synchronously without issuing another model call',
    parameters:Type.Object({sample:Type.Union([Type.Literal('first'),Type.Literal('second')])}),
    async execute(id,args,signal,_update,ctx){
      if(!signal||ctx.signal!==signal||signal.aborted)throw new Error('Original tool owner missing');
      await write(ctx.cwd,{kind:'tool-start',toolCallId:id,sample:args.sample});
      const observed=observe(ctx);
      const result={probe:'context-usage',nonce,originalToolCallId:id,sample:args.sample,...observed};
      await write(ctx.cwd,{kind:'tool-completed',toolCallId:id,sample:args.sample,result});
      return {content:[{type:'text',text:JSON.stringify(result)}],details:{contextUsageObservation:result}};
    }});
}`;
}

export async function prepareContextUsageProject(project, nonce) {
  await prepareCodingProject(project);
  await writeContextUsageExtension(project, nonce);
}

export async function writeContextUsageExtension(project, nonce) {
  await mkdir(join(project, '.pi/extensions'), { recursive: true });
  await writeFile(join(project, '.pi/mcp.json'), '{}');
  await writeFile(join(project, '.pi/extensions/context-usage.ts'), contextUsageExtensionSource(nonce, project));
}

export async function startContextUsageLoopback({ holdFinal = false } = {}) {
  // 严格复用普通 wire 与真实 SDK 转换，不在 fixture 中返回 getContextUsage 值。
  return startCodingLoopback({ holdFinal, callsOverride: [
    [contextUsageIds.tool, { sample: 'first' }],
    [contextUsageIds.tool, { sample: 'second' }],
  ] });
}

export async function contextUsageTrace(project) {
  try { return (await readFile(join(project, contextUsageIds.trace), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export function parseContextUsageResult(text) { return JSON.parse(text); }

export function assertContextUsageObservation(assert, observed, { nonce, callId, ordinal, modelId, provider = 'user-defined' }) {
  assert.equal(observed.nonce, nonce);
  if (callId !== undefined) assert.equal(observed.originalToolCallId, callId);
  assert.equal(observed.synchronous, true, 'Public API returns a value synchronously, not a Promise/undefined');
  assert.equal(observed.differentObject, true, 'Each call returns an independent finite snapshot');
  assert.deepEqual(observed.before, observed.second, 'Mutating a returned snapshot cannot change the next public read');
  assert.deepEqual(Object.keys(observed.second).sort(), ['contextWindow', 'percent', 'tokens']);
  assert.equal(observed.model.provider, provider); assert.equal(observed.model.id, modelId);
  assert.equal(observed.model.contextWindow, contextUsageIds.contextWindow);
  // 该场景无压缩／历史编辑；工具前的最近真实模型 response usage 为 ordinal+1，后无 trailing message。
  const tokens = ordinal + 1;
  assert.deepEqual(observed.second, { tokens, contextWindow: observed.model.contextWindow,
    percent: tokens / observed.model.contextWindow * 100 });
  assert.notEqual(observed.second.tokens, -701); assert.equal(Object.hasOwn(observed.second, 'extra'), false);
}
