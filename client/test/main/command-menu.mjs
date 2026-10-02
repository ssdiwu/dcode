import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {createServer} from "vite";
import electron from "electron";

const client=fileURLToPath(new URL("../../",import.meta.url));
const fixture=fileURLToPath(new URL("./command-menu-fixture.tsx",import.meta.url));
const runner=fileURLToPath(new URL("./command-menu-runner.cjs",import.meta.url));
const temp=await mkdtemp(join(tmpdir(),"dcode-command-menu-"));
const html=join(temp,"fixture.html");
await writeFile(html,'<!doctype html><html><head><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}.fixture-area{height:100%;display:grid;place-items:center}.fixture-composer{width:min(760px,calc(100vw - 48px))}</style></head><body><div id="root"></div><script type="module" src="/@fs'+fixture+'"></script></body></html>');
const server=await createServer({configFile:join(client,"vite.config.ts"),resolve:{dedupe:["react","react-dom","swr"]},server:{port:0,strictPort:false,hmr:false,fs:{allow:[client,temp]}}});
try{
  await server.listen();
  const address=server.httpServer.address();
  const url="http://127.0.0.1:"+address.port+"/@fs"+html;
  const env={...process.env,DCODE_TEST_URL:url,DCODE_TEST_OUTPUT:temp};
  delete env.ELECTRON_RUN_AS_NODE;
  let result;
  try{result=await promisify(execFile)(electron,[runner],{cwd:client,env,timeout:60000,maxBuffer:2_000_000});}
  catch(error){result=error;}
  const evidence=JSON.parse(await readFile(join(temp,"result.json"),"utf8"));
  console.log(JSON.stringify({temp,...evidence}));
  assert.equal(evidence.passed,true,JSON.stringify(result));
}finally{await server.close();}
