/** 原图片请求拥有的固定解码资源；原字节仅在真实解码通过后才可发布。 */
import { Worker } from 'node:worker_threads';
import type { ImageContent } from '@earendil-works/pi-ai';

/** 压缩字节不能约束解码内存，先拒绝无界画布；不是 native/WASM 内存沙箱。 */
const CAPACITY = Object.freeze({
  images: 4, base64: 8 * 1024 * 1024,
  dimension: 16_384, imagePixels: 16_777_216, batchPixels: 33_554_432,
});

// 固定源码，不运行扩展给的 Worker 代码；SDK 自身同步 fallback 也留在外层线程内。
const DECODER = String.raw`
const {parentPort,workerData}=require('node:worker_threads');
const limits=workerData.limits;
const invalid=()=>{throw new Error('invalid-image');};
const capacity=()=>{throw new Error('image-capacity');};
let batchPixels=0;
function dimensions(width,height){
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0)invalid();
  if(width>limits.dimension||height>limits.dimension||width*height>limits.imagePixels)capacity();
  return {width,height};
}
function charge(pixels){
  batchPixels+=pixels;
  if(!Number.isSafeInteger(batchPixels)||batchPixels>limits.batchPixels)capacity();
}
function inside(x,y,width,height,canvas){
  dimensions(width,height);
  if(x+width>canvas.width||y+height>canvas.height)invalid();
}
function ascii(bytes,start,end){return bytes.toString('ascii',start,end);}
function png(bytes){
  if(bytes.length<33||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))invalid();
  if(bytes.readUInt32BE(8)!==13||ascii(bytes,12,16)!=='IHDR')invalid();
  const canvas=dimensions(bytes.readUInt32BE(16),bytes.readUInt32BE(20));
  let cursor=8,frames=0,declaredFrames=0,sawData=false,ended=false;
  while(cursor+12<=bytes.length){
    const size=bytes.readUInt32BE(cursor),end=cursor+12+size;
    if(end>bytes.length)invalid();
    const kind=ascii(bytes,cursor+4,cursor+8),data=cursor+8;
    if(kind==='IHDR'&&cursor!==8)invalid();
    if(kind==='IDAT')sawData=true;
    if(kind==='acTL'){
      if(size!==8||declaredFrames||sawData)invalid();
      declaredFrames=bytes.readUInt32BE(data);
      if(!declaredFrames)invalid();
    }
    if(kind==='fcTL'){
      if(!declaredFrames||size!==26)invalid();
      const width=bytes.readUInt32BE(data+4),height=bytes.readUInt32BE(data+8);
      inside(bytes.readUInt32BE(data+12),bytes.readUInt32BE(data+16),width,height,canvas);
      charge(width*height);frames++;
    }
    if(kind==='IEND'){
      if(size!==0||end!==bytes.length)invalid();
      ended=true;break;
    }
    cursor=end;
  }
  if(!ended||!sawData||frames!==declaredFrames)invalid();
  if(!frames)charge(canvas.width*canvas.height);
  return canvas;
}
function jpeg(bytes){
  if(bytes.length<4||bytes[0]!==255||bytes[1]!==216)invalid();
  let cursor=2,canvas;
  const sof=new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
  while(cursor<bytes.length){
    if(bytes[cursor++]!==255)invalid();
    while(bytes[cursor]===255)cursor++;
    if(cursor>=bytes.length)invalid();
    const marker=bytes[cursor++];
    if(marker===0xda){if(!canvas)invalid();charge(canvas.width*canvas.height);return canvas;}
    if(marker===0xd9)invalid();
    if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
    if(cursor+2>bytes.length)invalid();
    const size=bytes.readUInt16BE(cursor);
    if(size<2||cursor+size>bytes.length)invalid();
    if(sof.has(marker)){
      if(size<8)invalid();
      const current=dimensions(bytes.readUInt16BE(cursor+5),bytes.readUInt16BE(cursor+3));
      if(canvas&&(canvas.width!==current.width||canvas.height!==current.height))invalid();
      canvas=current;
    }
    cursor+=size;
  }
  invalid();
}
function gif(bytes){
  if(bytes.length<13||!['GIF87a','GIF89a'].includes(ascii(bytes,0,6)))invalid();
  const canvas=dimensions(bytes.readUInt16LE(6),bytes.readUInt16LE(8));
  let cursor=13,frames=0;
  if(bytes[10]&0x80)cursor+=3*(1<<((bytes[10]&7)+1));
  const subblocks=()=>{
    for(;;){
      if(cursor>=bytes.length)invalid();
      const size=bytes[cursor++];
      if(size===0)return;
      cursor+=size;if(cursor>bytes.length)invalid();
    }
  };
  while(cursor<bytes.length){
    const kind=bytes[cursor++];
    if(kind===0x3b){if(!frames||cursor!==bytes.length)invalid();return canvas;}
    if(kind===0x21){if(cursor>=bytes.length)invalid();cursor++;subblocks();continue;}
    if(kind!==0x2c||cursor+9>bytes.length)invalid();
    const width=bytes.readUInt16LE(cursor+4),height=bytes.readUInt16LE(cursor+6);
    inside(bytes.readUInt16LE(cursor),bytes.readUInt16LE(cursor+2),width,height,canvas);
    charge(width*height);frames++;
    const packed=bytes[cursor+8];cursor+=9;
    if(packed&0x80)cursor+=3*(1<<((packed&7)+1));
    if(cursor>=bytes.length)invalid();
    cursor++;subblocks();
  }
  invalid();
}
function webpPixels(bytes,start,end,kind){
  if(kind==='VP8 '){
    if(start+10>end||(bytes[start]&1)!==0||!bytes.subarray(start+3,start+6).equals(Buffer.from([157,1,42])))invalid();
    return dimensions(bytes.readUInt16LE(start+6)&0x3fff,bytes.readUInt16LE(start+8)&0x3fff);
  }
  if(kind==='VP8L'){
    if(start+5>end||bytes[start]!==0x2f)invalid();
    const bits=bytes.readUInt32LE(start+1);
    return dimensions((bits&0x3fff)+1,((bits>>>14)&0x3fff)+1);
  }
  invalid();
}
function webp(bytes){
  if(bytes.length<20||ascii(bytes,0,4)!=='RIFF'||ascii(bytes,8,12)!=='WEBP'||bytes.readUInt32LE(4)+8!==bytes.length)invalid();
  let cursor=12,canvas,frames=0,pixels=0,animated=false;
  while(cursor+8<=bytes.length){
    const kind=ascii(bytes,cursor,cursor+4),size=bytes.readUInt32LE(cursor+4),start=cursor+8,end=start+size;
    if(end>bytes.length)invalid();
    if(kind==='VP8X'){
      if(canvas||size!==10)invalid();
      canvas=dimensions(bytes.readUIntLE(start+4,3)+1,bytes.readUIntLE(start+7,3)+1);
      animated=Boolean(bytes[start]&2);
    }else if(kind==='VP8 '||kind==='VP8L'){
      if(animated||pixels)invalid();
      const decoded=webpPixels(bytes,start,end,kind);
      if(canvas&&(decoded.width!==canvas.width||decoded.height!==canvas.height))invalid();
      canvas=decoded;pixels++;charge(canvas.width*canvas.height);
    }else if(kind==='ANMF'){
      if(!animated||!canvas||size<16)invalid();
      const width=bytes.readUIntLE(start+6,3)+1,height=bytes.readUIntLE(start+9,3)+1;
      inside(bytes.readUIntLE(start,3)*2,bytes.readUIntLE(start+3,3)*2,width,height,canvas);
      let frameCursor=start+16,framePixels=0;
      while(frameCursor+8<=end){
        const subkind=ascii(bytes,frameCursor,frameCursor+4),subsize=bytes.readUInt32LE(frameCursor+4),substart=frameCursor+8,subend=substart+subsize;
        if(subend>end)invalid();
        if(subkind==='VP8 '||subkind==='VP8L'){
          const decoded=webpPixels(bytes,substart,subend,subkind);
          if(framePixels||decoded.width!==width||decoded.height!==height)invalid();
          framePixels++;
        }
        frameCursor=subend+(subsize&1);
      }
      if(frameCursor!==end||framePixels!==1)invalid();
      charge(width*height);frames++;
    }
    cursor=end+(size&1);
  }
  if(cursor!==bytes.length||!canvas||(animated?frames===0:pixels!==1))invalid();
  return canvas;
}
function bmp(bytes){
  if(bytes.length<26||ascii(bytes,0,2)!=='BM')invalid();
  const size=bytes.readUInt32LE(14);
  if(14+size>bytes.length)invalid();
  let canvas;
  if(size===12)canvas=dimensions(bytes.readUInt16LE(18),bytes.readUInt16LE(20));
  else if(size>=40)canvas=dimensions(bytes.readInt32LE(18),Math.abs(bytes.readInt32LE(22)));
  else invalid();
  charge(canvas.width*canvas.height);return canvas;
}
function inspect(image){
  const beforePixels=batchPixels;
  const bytes=Buffer.from(image.data,'base64');
  // Buffer.from 本身宽松，往返相等才接受规范 base64，避免声明和实际字节不一致。
  if(bytes.toString('base64')!==image.data)invalid();
  let mimeType,canvas;
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){mimeType='image/png';canvas=png(bytes);}
  else if(bytes[0]===255&&bytes[1]===216){mimeType='image/jpeg';canvas=jpeg(bytes);}
  else if(['GIF87a','GIF89a'].includes(ascii(bytes,0,6))){mimeType='image/gif';canvas=gif(bytes);}
  else if(ascii(bytes,0,4)==='RIFF'&&ascii(bytes,8,12)==='WEBP'){mimeType='image/webp';canvas=webp(bytes);}
  else if(ascii(bytes,0,2)==='BM'){mimeType='image/bmp';canvas=bmp(bytes);}
  else invalid();
  if(image.mimeType!==mimeType)invalid();
  // 稀疏动画的小帧不能藏住大画布；单图同时约束画布和累计帧，批次计较大者。
  const imagePixels=Math.max(batchPixels-beforePixels,canvas.width*canvas.height);
  if(imagePixels>limits.imagePixels)capacity();
  charge(imagePixels-(batchPixels-beforePixels));
  return {image,bytes,...canvas};
}
(async()=>{
  try{
    // 先核全批容器/尺寸，再导入 SDK 及真正解码，不让后图的超限变成部分放行。
    const inspected=workerData.images.map(inspect);
    const {resizeImage}=await import(workerData.sdkRoot);
    for(const current of inspected){
      const decoded=await resizeImage(new Uint8Array(current.bytes),current.image.mimeType,{
        maxWidth:limits.dimension,maxHeight:limits.dimension,maxBytes:limits.base64,jpegQuality:80,
      });
      if(!decoded||decoded.wasResized!==false||decoded.data!==current.image.data
        ||decoded.mimeType!==current.image.mimeType
        ||!((decoded.width===current.width&&decoded.height===current.height)
          ||(current.image.mimeType==='image/jpeg'&&decoded.width===current.height&&decoded.height===current.width))
        ||decoded.originalWidth!==decoded.width||decoded.originalHeight!==decoded.height
        ||!Buffer.from(decoded.data,'base64').equals(current.bytes))invalid();
    }
    parentPort.postMessage({ok:true});
  }catch(error){
    parentPort.postMessage({ok:false,code:error?.message==='image-capacity'?'image-capacity':'invalid-image'});
  }finally{parentPort.close();}
})();
`;

const abortError = () => new DOMException('Image validation cancelled', 'AbortError');

/**
 * 只验证，不写入、缩图、重编码或替换 caller 图片；兑现时真实外层 Worker 已退出。
 * 宿主须先把 SDK 的有限 identity/usage 回执交给原费用 owner，不能等本函数才认账。
 */
export async function validateGeneratedImages(images: readonly ImageContent[], signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError();
  if (!Array.isArray(images) || images.length > CAPACITY.images) throw new Error('Invalid images');
  let size = 0;
  const snapshot = images.map(image => {
    if (!image || image.type !== 'image' || !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'].includes(image.mimeType)
      || typeof image.data !== 'string' || image.data.length === 0 || image.data.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new Error('Invalid image content');
    size += image.data.length;
    if (size > CAPACITY.base64) throw new Error('Image capacity exceeded');
    return { type: 'image' as const, mimeType: image.mimeType, data: image.data };
  });
  // 根公开 exports，打包时必须保留已安装 SDK 的公共入口可解析性。
  const sdkRoot = import.meta.resolve('@earendil-works/pi-coding-agent');
  await new Promise<void>((resolve, reject) => {
    let result: { ok: boolean; code?: string } | undefined;
    let failure: Error | undefined;
    let cancelled = false;
    const worker = new Worker(DECODER, {
      eval: true, execArgv: [], env: { PATH: process.env.PATH ?? '', LANG: 'C', PI_OFFLINE: '1' },
      workerData: { images: snapshot, limits: CAPACITY, sdkRoot },
      // V8 堆限制不覆盖 WASM/native 内存，只作为额外约束，不能替代尺寸门。
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    const cancel = () => {
      cancelled = true;
      // 取消只请求终止，下面的 exit 事件才兑现成功/失败 Promise。
      void worker.terminate().catch(() => { failure = new Error('Image worker termination failed'); });
    };
    const budget = setTimeout(() => { failure = new Error('Image validation budget exceeded'); void worker.terminate().catch(() => { failure = new Error('Image worker termination failed'); }); }, 10_000);
    worker.on('message', (message: unknown) => {
      if (cancelled) return;
      if (result !== undefined || typeof message !== 'object' || message === null || Array.isArray(message)
        || !('ok' in message) || typeof message.ok !== 'boolean'
        || Object.keys(message).some(key => key !== 'ok' && key !== 'code')) {
        failure = new Error('Invalid image worker response');
        void worker.terminate().catch(() => { failure = new Error('Image worker termination failed'); });
        return;
      }
      const code = 'code' in message ? message.code : undefined;
      if (message.ok ? code !== undefined : !['invalid-image', 'image-capacity'].includes(String(code))) {
        failure = new Error('Invalid image worker response');
        return;
      }
      result = { ok: message.ok, ...(code === undefined ? {} : { code: String(code) }) };
    });
    worker.once('error', () => { failure = new Error('Image worker failed'); });
    worker.once('exit', code => {
      clearTimeout(budget);
      signal.removeEventListener('abort', cancel);
      // 即使 success 已进消息队列，较新的 abort 也不能兑现成功。
      if (cancelled || signal.aborted) reject(abortError());
      else if (failure) reject(failure);
      else if (code !== 0 || result === undefined) reject(new Error('Image worker exited without validation'));
      else if (!result.ok) reject(new Error(result.code === 'image-capacity' ? 'Image pixel capacity exceeded' : 'Invalid decoded image'));
      else resolve();
    });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
