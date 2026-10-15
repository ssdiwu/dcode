// 普通装配的受控 HTTP 对端，只返回工具意图；文件、命令与数字出口由真实 Pi 工具产生。
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const codingKey = 'isolated-coding-fixture-key';
export const codingModel = 'isolated-coding-fixture';
export const searchCalls = [
  ['ls', { path: '.' }],
  ['find', { pattern: '*.mjs' }],
  ['grep', { pattern: 'return a - b', path: 'index.mjs', literal: true }],
];

export async function prepareCodingProject(project) {
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'AGENTS.md'), '项目指令标识：coding-agents-real-context。修复加法并运行本目录的 check.mjs。\n');
  const skillDir = join(project, '.pi', 'skills', 'checker'); await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: dcode-isolated-project-checker\ndescription: coding-project-skill-marker\n---\nUse the actual project test to verify addition.\n');
  await writeFile(join(project, 'index.mjs'), 'export function add(a, b) { return a - b; }\n');
  await writeFile(join(project, 'check.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './index.mjs';\ntest('actual addition', () => assert.equal(add(2, 3), 5));\n");
}

export async function startCodingLoopback({ holdFinal = false, prefixCalls = [], subsequentCalls = [], firstRoundCalls, callsOverride, expectedModels = [codingModel], expectedKey = codingKey, expectedCatalogHeader, ownedComplete } = {}) {
  const requests = [];
  const errors = [];
  const completeRequests = [];
  const nonce = `coding-result-${randomUUID()}`;
  const held = new Set();
  let finalReleased = !holdFinal;
  const calls = callsOverride ?? [
    ...prefixCalls,
    ['read', { path: 'index.mjs' }],
    ['write', { path: 'audit.txt', content: 'actual tool creation\n' }],
    ['bash', { command: 'node --test check.mjs' }],
    ['edit', { path: 'index.mjs', edits: [{ oldText: 'return a - b;', newText: 'return a + b;' }] }],
    ['bash', { command: "node --test check.mjs && printf 'actual build output\\n' > build.txt && rm audit.txt" }],
  ];
  const reply = (res, body, ordinal) => {
    const call = ordinal <= calls.length ? calls[ordinal - 1] : subsequentCalls[ordinal - calls.length - 2];
    const round=ordinal===1&&firstRoundCalls?firstRoundCalls:call?[call]:[];
    const delta = round.length ? { role: 'assistant', tool_calls: round.map((tool,index)=>({ index, id: round.length===1?`actual-tool-${ordinal}`:`actual-tool-${ordinal}-${index}`, type: 'function',
      function: { name: tool[0], arguments: JSON.stringify(tool[1]) } })) } : { role: 'assistant', content: nonce };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunks = [
      { id: `actual-response-${ordinal}`, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] },
      { id: `actual-response-${ordinal}`, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: round.length ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: ordinal, completion_tokens: 1, total_tokens: ordinal + 1 } },
    ];
    res.end(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/catalog') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[],"providers":[]}'); return; }
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { errors.push('invalid request JSON'); res.writeHead(400); res.end(); return; }
      const authOk = req.headers.authorization === `Bearer ${expectedKey}`;
      const catalogHeaderOk = expectedCatalogHeader === undefined || req.headers['x-dcode-catalog-secret'] === expectedCatalogHeader;
      // 仅测试对端分流一个真实主动complete；不能让内层HTTP占走外层工具脚本ordinal。
      if (ownedComplete && body.messages?.some(message => message.role === 'user' && message.content === ownedComplete.marker)) {
        const record = { ordinal:completeRequests.length + 1, responseId:ownedComplete.responseId, authOk,
          model:body.model, accepted:true, finished:false, input:117, output:13 };
        completeRequests.push(record);
        if (!authOk || !expectedModels.includes(body.model) || !catalogHeaderOk || record.ordinal !== 1) {
          errors.push('owned complete identity or duplicate invalid'); res.writeHead(400); res.end(); return;
        }
        res.writeHead(200, { 'content-type':'text/event-stream' });
        const chunks = [
          {id:record.responseId,model:body.model,choices:[{index:0,delta:{role:'assistant',content:ownedComplete.text},finish_reason:null}]},
          {id:record.responseId,model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:117,completion_tokens:13,total_tokens:130}},
        ];
        record.finished=true;res.end(chunks.map(chunk=>'data: '+JSON.stringify(chunk)+'\n\n').join('')+'data: [DONE]\n\n');return;
      }
      const ordinal = requests.length + 1;
      requests.push({ ordinal, body, authOk, receivedAt:Date.now(), extensionHeader:req.headers['x-dcode-extension-fixture']??null,
        ...(expectedCatalogHeader === undefined ? {} : { catalogHeaderOk }) });
      if (!authOk || !expectedModels.includes(body.model) || !catalogHeaderOk || ordinal > calls.length + subsequentCalls.length + 3) {
        errors.push('request identity or count invalid'); res.writeHead(400); res.end(); return;
      }
      if (ordinal > calls.length && !finalReleased) {
        const pending = { res, body, ordinal }; held.add(pending); res.once('close', () => held.delete(pending));
      } else reply(res, body, ordinal);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { origin: `http://127.0.0.1:${address.port}`, requests, completeRequests, errors, nonce,
    releaseFinal() { finalReleased = true; for (const pending of held) reply(pending.res, pending.body, pending.ordinal); held.clear(); },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}
