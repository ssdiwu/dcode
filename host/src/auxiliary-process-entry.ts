// A process-group leader for one command. It remains alive while background
// children run, so the owning Host can stop this exact group without PID reuse.
import {spawn,execFile} from 'node:child_process';
let started=false,settled=false,polling=false,stopping=false;
let timer:ReturnType<typeof setInterval>|undefined;
const send=(message:unknown)=>{if(process.connected)process.send?.(message);};
function stop(){if(stopping)return;stopping=true;if(timer)clearInterval(timer);try{process.kill(-process.pid,'SIGKILL');}catch{process.exit(1);}}
function members():Promise<number[]>{return new Promise((resolve,reject)=>{const probe=execFile('/bin/ps',['-axo','pid=,pgid='],{encoding:'utf8',timeout:3000,maxBuffer:4*1024*1024},(error,stdout)=>{if(error){reject(error);return;}resolve(stdout.trim().split('\n').flatMap(line=>{const [pid,group]=line.trim().split(/\s+/).map(Number);return group===process.pid&&pid!==process.pid&&pid!==probe.pid?[pid!]:[];}));});});}
async function poll(){if(polling||stopping||!settled)return;polling=true;try{const pids=await members();send({kind:'members',pids});if(!pids.length){if(timer){clearInterval(timer);timer=undefined;}send({kind:'empty'});process.disconnect?.();process.exitCode=0;}}catch{send({kind:'inspectionFailed'});}finally{polling=false;}}
process.on('message',(packet:unknown)=>{
  if(!packet||typeof packet!=='object')return;const input=packet as Record<string,unknown>;
  if(input.kind==='stop'){stop();return;}
  if(input.kind!=='run'||started||typeof input.command!=='string'||typeof input.cwd!=='string')return;started=true;
  const child=spawn('/bin/bash',['-s'],{cwd:input.cwd,env:input.env as NodeJS.ProcessEnv,stdio:['pipe','pipe','pipe'],detached:false});
  child.stdin.on('error',()=>{});child.stdin.end(input.command+'\n');
  child.stdout.on('data',(data:Buffer)=>send({kind:'data',data}));child.stderr.on('data',(data:Buffer)=>send({kind:'data',data}));
  if(child.pid)send({kind:'started',shellPid:child.pid});
  child.once('error',()=>{send({kind:'spawnFailed'});stop();});
  child.once('exit',(exitCode)=>{void (async()=>{settled=true;try{const pids=await members();send({kind:'settled',exitCode,pids});if(!pids.length){send({kind:'empty'});process.disconnect?.();process.exitCode=0;}else{timer=setInterval(()=>void poll(),1000);}}catch{send({kind:'settled',exitCode,pids:[],inspectionFailed:true});timer=setInterval(()=>void poll(),1000);}})();});
});
process.on('disconnect',()=>{if(!settled||timer)stop();});
process.on('SIGTERM',stop);process.on('SIGINT',stop);
send({kind:'ready',pid:process.pid});
