// 普通runtime/桌面共用的原SDK图像HTTP与项目扩展资产。
// Importing this module performs no I/O and registers no tests or model/provider wrapper.
// Only the loopback server represents the remote service. The extension calls the real SDK.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const imageFixtureIds = Object.freeze({
  provider: 'openrouter',
  chat: 'openai/gpt-4o',
  image: 'google/gemini-2.5-flash-image',
  api: 'openrouter-images',
  tool: 'owned_image_contract',
  call: 'owned-image-call-1',
});
const ids = imageFixtureIds;
export const imageFixtureFiles = Object.freeze({
  trace: 'owned-image-trace.json',
  effects: 'owned-image-effects.jsonl',
  cancel: 'owned-image-cancel.json',
  release: 'owned-image-owner-release.json',
});
const files = imageFixtureFiles;

// These are wire token counts only. The real SDK computes Usage and catalog-priced cost.
export const imageWireUsage = Object.freeze({
  prompt_tokens: 117,
  completion_tokens: 13,
  total_tokens: 130,
  prompt_tokens_details: Object.freeze({ cached_tokens: 9, cache_write_tokens: 2 }),
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const typeBytes = Buffer.from(type, 'ascii');
  const size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])));
  return Buffer.concat([size, typeBytes, payload, crc]);
}

// A complete RGB PNG: genuine IHDR, filtered scanlines, zlib IDAT, CRCs and IEND.
// Input is split vertically; output has four contrasting quadrants. Both remain 8 x 6.
function patternPng(nonce, variant) {
  const width = 8, height = 6;
  const hash = createHash('sha256').update(variant + ':' + nonce).digest();
  const warm = [180 + hash[0] % 60, 24 + hash[1] % 48, 32 + hash[2] % 48];
  const cool = [24 + hash[3] % 48, 144 + hash[4] % 64, 180 + hash[5] % 60];
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    rows[row] = 0;
    for (let x = 0; x < width; x++) {
      const right = x >= width / 2;
      const alternate = variant === 'output' && y >= height / 2;
      const color = right !== alternate ? cool : warm;
      rows.set(color, row + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function makeImageFixtureAssets(nonce) {
  if (typeof nonce !== 'string' || nonce.length === 0) throw new TypeError('Owned nonce required');
  const input = patternPng(nonce, 'input'), output = patternPng(nonce, 'output');
  return {
    inputImage: { type: 'image', mimeType: 'image/png', data: input.toString('base64') },
    outputImage: { type: 'image', mimeType: 'image/png', data: output.toString('base64') },
    inputText: 'IMAGE_INPUT_' + nonce,
    outputText: 'IMAGE_GENERATED_TEXT_' + nonce,
    width: 8,
    height: 6,
    inputSha256: createHash('sha256').update(input).digest('hex'),
    outputSha256: createHash('sha256').update(output).digest('hex'),
    inputBytes: input.length,
    outputBytes: output.length,
  };
}

function damagedImage(image) {
  const bytes=Buffer.from(image.data,'base64');let cursor=8;
  while(cursor+12<=bytes.length){const size=bytes.readUInt32BE(cursor);if(bytes.toString('ascii',cursor+4,cursor+8)==='IDAT'){bytes[cursor+8]^=255;bytes.writeUInt32BE(crc32(bytes.subarray(cursor+4,cursor+8+size)),cursor+8+size);break;}cursor+=12+size;}
  return {...image,data:bytes.toString('base64')};
}
export function makeCapacityImageAssets(nonce) {
  const assets=makeImageFixtureAssets(nonce),bytes=Buffer.from(assets.outputImage.data,'base64');
  const target=6*1024*1024-2048,padding=Buffer.alloc(target-bytes.length-12,65);padding.write('owned-padding\0',0,'ascii');
  const padded=Buffer.concat([bytes.subarray(0,33),pngChunk('tEXt',padding),bytes.subarray(33)]);
  const prefix='IMAGE_GENERATED_TEXT_'+nonce;
  return {...assets,outputImage:{...assets.outputImage,data:padded.toString('base64')},outputText:prefix+'\x01'.repeat(1024*1024-Buffer.byteLength(prefix)),outputBytes:padded.length,outputSha256:createHash('sha256').update(padded).digest('hex')};
}
const dataUri = image => 'data:' + image.mimeType + ';base64,' + image.data;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// Modes change only actual remote JSON; neither a public AssistantImages nor a fee is fabricated.
// hold=true leaves the image response pending until releaseImages(), cancellation, or close().
export async function startImageLoopback({
  nonce, key, mode = 'success', hold = false, warmup = false,
  assets = mode === 'capacity' ? makeCapacityImageAssets(nonce) : makeImageFixtureAssets(nonce), chatModel = ids.chat,
}) {
  if (!['success', 'billed-malformed-images', 'bad-pixels', 'empty-images', 'no-usage', 'model-cancel', 'boundary-rejects', 'capacity'].includes(mode)) {
    throw new TypeError('Unsupported owned image fixture mode: ' + mode);
  }
  if (typeof key !== 'string' || key.length === 0) throw new TypeError('Owned fixture credential required');
  const requests = [], invalid = [], held = new Map(), sockets = new Set();
  const expectedImageContent = [
    { type: 'text', text: assets.inputText },
    { type: 'image_url', image_url: { url: dataUri(assets.inputImage) } },
  ];
  const imageResponse = ordinal => ({
    id: 'image-response-' + nonce + '-' + ordinal,
    model: ids.image,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: assets.outputText,
        // The SDK stores usage first, then rejects a noniterable images value itself.
        images: mode === 'empty-images' ? [] : mode === 'billed-malformed-images'
          ? 42
          : [{ type: 'image_url', image_url: { url: dataUri(mode === 'bad-pixels' ? damagedImage(assets.outputImage) : assets.outputImage) } }],
      },
      finish_reason: 'stop',
    }],
    ...(mode === 'no-usage' ? {} : { usage: imageWireUsage }),
  });
  const respondImage = (record, res) => {
    if (res.destroyed || res.writableEnded || record.finished) {
      throw new Error('Actual held image HTTP already closed or completed');
    }
    const response = imageResponse(record.ordinal);
    record.response = response; record.responseId = response.id; record.responseWritten = true;
    held.delete(record);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  };
  const sse = (res, id, delta, finish, usage) => res.write('data: ' + JSON.stringify({
    id, model: chatModel, choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  }) + '\n\n');
  const server = http.createServer((req, res) => {
    // Catalog reads are ordinary initialization, carry no model body, and are not model attempts.
    if (req.method === 'GET') {
      if ((req.url ?? '').startsWith('/catalog')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"models":[],"providers":[]}');
      } else { res.writeHead(404); res.end(); }
      return;
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { invalid.push('invalid-json'); res.writeHead(400); res.end('{}'); return; }
      const path = req.url;
      const kind = path !== '/v1/chat/completions' ? 'unknown'
        : body.stream === false || body.modalities !== undefined || body.model === ids.image ? 'images' : 'chat';
      const ordinal = requests.filter(item => item.kind === kind).length + 1;
      const record = {
        kind, ordinal, path, method: req.method, body,
        authOk: req.headers.authorization === 'Bearer ' + key,
        accepted: false, responseWritten: false, finished: false, closedBeforeFinal: false, errors: [],
      };
      requests.push(record);
      res.once('finish', () => { record.finished = true; });
      res.once('close', () => {
        record.closedBeforeFinal = !record.finished;
        held.delete(record);
      });
      const reject = reason => {
        record.errors.push(reason); invalid.push(reason);
      };
      if (kind === 'unknown' || req.method !== 'POST') reject('unexpected-route-or-method');
      if (!record.authOk) reject('unexpected-auth');
      if (kind === 'images') {
        if (ordinal > 1) reject('image-request-replayed');
        if (body.model !== ids.image) reject('wrong-image-model');
        if (body.stream !== false) reject('image-request-must-be-nonstreaming');
        // Exact installed canonical output is ["image","text"], in that SDK order.
        if (!same(body.modalities, ['image', 'text'])) reject('wrong-canonical-image-modalities');
        if (!same(body.messages, [{ role: 'user', content: expectedImageContent }])) {
          reject('wrong-original-image-input');
        }
      } else if (kind === 'chat') {
        if (ordinal > (warmup ? 3 : 2)) reject('unexpected-outer-request');
        if (body.model !== chatModel) reject('wrong-outer-model');
        if (body.stream !== true) reject('outer-chat-must-stream');
        const toolOrdinal = warmup ? 2 : 1;
        if (ordinal === toolOrdinal && !body.tools?.some(tool => tool.function?.name === ids.tool)) {
          reject('original-image-tool-not-offered');
        }
        record.hasOriginalToolResult = Array.isArray(body.messages)
          && body.messages.some(message => message.role === 'tool' && message.tool_call_id === ids.call);
        record.forwardedOutputImage = Array.isArray(body.messages) && body.messages.some(message =>
          Array.isArray(message.content) && message.content.some(item =>
            item.type === 'image_url' && item.image_url?.url === dataUri(assets.outputImage)));
        record.forwardedOutputText = Array.isArray(body.messages) && body.messages.some(message =>
          typeof message.content === 'string'
            ? message.content.includes(mode==='capacity'?assets.outputText.slice(0,128):assets.outputText)
            : Array.isArray(message.content) && message.content.some(item =>
              item.type === 'text' && item.text?.includes(mode==='capacity'?assets.outputText.slice(0,128):assets.outputText)));
      }
      if (record.errors.length > 0) {
        record.responseWritten = true;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: record.errors.join(', ') } }));
        return;
      }
      record.accepted = true;
      if (kind === 'images') {
        if (hold) { held.set(record, res); return; }
        respondImage(record, res); return;
      }
      const responseId = 'outer-image-' + nonce + '-' + ordinal;
      record.responseId = responseId; record.responseWritten = true;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (warmup && ordinal === 1) {
        record.reply = 'IMAGE_WARMUP_REPLY_' + nonce;
        sse(res, responseId, { role: 'assistant', content: record.reply }, null);
        sse(res, responseId, {}, 'stop', { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
      } else if (ordinal === (warmup ? 2 : 1)) {
        sse(res, responseId, { role: 'assistant', tool_calls: [{
          index: 0, id: ids.call, type: 'function', function: { name: ids.tool, arguments: '{}' },
        }] }, null);
        sse(res, responseId, {}, 'tool_calls', { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
      } else {
        record.reply = 'IMAGE_OUTER_REPLY_' + nonce;
        sse(res, responseId, { role: 'assistant', content: record.reply }, null);
        sse(res, responseId, {}, 'stop', { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    const failed = error => reject(error);
    server.once('error', failed);
    server.listen(0, '127.0.0.1', () => { server.off('error', failed); resolve(); });
  });
  return {
    origin: 'http://127.0.0.1:' + server.address().port,
    assets, requests, invalid, setKey(value) { key=value; },
    images: () => requests.filter(record => record.kind === 'images'),
    chats: () => requests.filter(record => record.kind === 'chat'),
    releaseImages() {
      if (held.size !== 1) throw new Error('Exactly one held actual image HTTP required');
      for (const [record, res] of held) respondImage(record, res);
    },
    // Closing destroys only this server's sockets. It never fabricates a final model response.
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

export function imageExtensionSource(nonce, mode = 'success', assets = makeImageFixtureAssets(nonce)) {
  const configuration = { nonce, mode, ids, files, inputText: assets.inputText, inputImage: assets.inputImage };
  // Owned source generation only; no product or SDK source is text-rewritten.
  function extension(pi) {
    pi.registerTool({
      name: cfg.ids.tool,
      label: 'owned image generation',
      description: 'One real SDK image generation from the original active tool',
      parameters: Type.Object({}),
      async execute(id, _args, signal, _onUpdate, ctx) {
        if (!signal || ctx.signal !== signal || signal.aborted) throw new Error('Original tool signal missing');
        const tracePath = join(ctx.cwd, cfg.files.trace), effectsPath = join(ctx.cwd, cfg.files.effects);
        const trace = { nonce: cfg.nonce, callId: id, mode: cfg.mode, steps: [] };
        const save = async () => {
          await writeFile(tracePath + '.tmp', JSON.stringify(trace));
          await rename(tracePath + '.tmp', tracePath);
        };
        const step = async (phase, value = {}) => { trace.steps.push({ phase, ...value }); await save(); };
        const markerExists = async name => {
          try {
            const value = JSON.parse(await readFile(join(ctx.cwd, name), 'utf8'));
            return value.nonce === cfg.nonce;
          } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
        };
        const waitMarker = async name => {
          const watcher = watch(ctx.cwd, { signal });
          try {
            if (await markerExists(name)) return;
            for await (const event of watcher) {
              if (event.filename === name && await markerExists(name)) return;
            }
            throw new Error('Owned marker watcher ended early');
          } finally { await watcher.return(); }
        };
        await appendFile(effectsPath, JSON.stringify({ phase: 'tool-start', nonce: cfg.nonce, callId: id }) + '\n');
        await step('tool-started', { ownerAborted: signal.aborted });
        const model = ctx.modelRegistry.getModelOfType('image', cfg.ids.provider, cfg.ids.image);
        if (!model || model.type !== 'image' || model.api !== cfg.ids.api
          || !model.output?.includes('image') || !model.output?.includes('text')) {
          throw new Error('Configured canonical image model missing');
        }
        if(cfg.mode==='boundary-rejects'){
          let reads=0;const denied=()=>{reads++;throw new Error('Getter must not run');};
          const cases=[
            ['model-proxy',new Proxy(model,{get:denied}),{},null],
            ['options-accessor',model,{get signal(){return denied();}},null],
            ['false-signal',model,{signal:{get aborted(){return denied();}}},null],
            ['metadata',model,{metadata:{requested:true}},null],
            ['temperature',model,{temperature:0.5},null],
            ['own-proto',model,Object.defineProperty({},'__proto__',{value:'unknown',enumerable:true}),null],
            ['non-json-input',model,{},()=>{}],
            ['five-input-images',model,{}, {input:Array(5).fill(cfg.inputImage)}],
            ['bad-input',model,{}, {input:[{type:'image',mimeType:'image/png',data:'file:///not-permitted'}]}],
          ];
          const results=[];
          for(const [name,chosen,options,input] of cases){let value;try{value=await ctx.modelRegistry.generateImages(chosen,input??{input:[{type:'text',text:cfg.inputText}]},options);}catch(error){await step('promise-rejected',{name});throw error;}results.push({name,value});}
          await step('boundary-results',{reads,results});return {content:[{type:'text',text:JSON.stringify({nonce:cfg.nonce,reads,results})}]};
        }
        const local = cfg.mode === 'model-cancel' ? new AbortController() : undefined;
        let cancelFlight, cancelError;
        if (local) {
          cancelFlight = waitMarker(cfg.files.cancel).then(() => local.abort()).catch(error => { cancelError = error; });
        }
        let result;
        try {
          result = await ctx.modelRegistry.generateImages(model, {
            input: [{ type: 'text', text: cfg.inputText }, cfg.inputImage],
          }, { signal: local?.signal ?? signal, maxRetries: 0 });
        } catch (error) {
          await step('promise-rejected', { ownerAborted: signal.aborted, message: String(error) });
          throw error;
        }
        await step('result-settled', {
          ownerAborted: signal.aborted,
          modelAborted: local?.signal.aborted ?? signal.aborted,
          result,
        });
        if (local && !signal.aborted) {
          await cancelFlight;
          if (cancelError) throw cancelError;
          if (signal.aborted || !local.signal.aborted) throw new Error('Model cancellation changed the original owner');
          await step('owner-still-active', { ownerAborted: signal.aborted });
          await waitMarker(cfg.files.release);
        }
        if (signal.aborted) {
          await step('owner-aborted', { ownerAborted: true });
          throw new Error('Aborted owner cannot claim a successful tool result');
        }
        await step('tool-returning', { ownerAborted: signal.aborted });
        // Preserve the real AssistantImages in details and feed its actual text/image blocks into
        // the formal AgentToolResult. The SDK/host remains the only source of request usage.
        const metadata=Object.fromEntries(Object.entries(result).filter(([key])=>key!=='output'));
        return {
          content: result.output.length ? result.output : [{type:'text',text:(result.errorMessage ?? 'No displayable image') + ' ' + cfg.nonce}],
          isError: result.stopReason !== 'stop',
          details: { imageResult: cfg.mode === 'capacity' ? metadata : result, nonce: cfg.nonce, originalToolCallId: id, ownerAlive: !signal.aborted },
        };
      },
    });
  }
  return 'import {Type} from "typebox";\n'
    + 'import {appendFile,writeFile,readFile,rename,watch} from "node:fs/promises";\n'
    + 'import {join} from "node:path";\nconst cfg=' + JSON.stringify(configuration)
    + ';\nexport default ' + extension.toString() + '\n';
}
