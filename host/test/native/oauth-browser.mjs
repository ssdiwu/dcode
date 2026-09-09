import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {mkdtemp,writeFile,readFile,access} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
const exec=promisify(execFile),root=fileURLToPath(new URL('../..',import.meta.url)),temp=await mkdtemp(join(tmpdir(),'dcode-oauth-opener-'));
const application=join(root,'../client/node_modules/electron/dist/Electron.app');await access(application);
const runner=join(temp,'receiver.cjs'),result=join(temp,'received.json'),synthetic='https://dcode-oauth-fixture.invalid/login?state=synthetic-test-only';
await writeFile(runner,`const {app}=require('electron');const fs=require('node:fs');app.setPath('userData',${JSON.stringify(join(temp,'profile'))});app.on('open-url',(event,url)=>{event.preventDefault();fs.writeFileSync(${JSON.stringify(result)},JSON.stringify({received:true,matched:url===${JSON.stringify(synthetic)},pid:process.pid}));setTimeout(()=>app.exit(0),300);});app.whenReady().then(()=>{app.setActivationPolicy('prohibited');});setTimeout(()=>app.exit(2),15000);`);
const driver=join(temp,'driver.swift'),binary=join(temp,'opener');await writeFile(driver,`import AppKit
@MainActor @main struct Driver {
 static func main() async {
  do {
   let data=FileHandle.standardInput.readDataToEndOfFile();let input=try JSONSerialization.jsonObject(with:data) as! [String:String]
   let config=NSWorkspace.OpenConfiguration();config.arguments=[input["runner"]!];config.createsNewApplicationInstance=true;config.activates=false;config.environment=["PATH":"/usr/bin:/bin:/usr/sbin:/sbin"]
   try await openOAuthBrowser(URL(string:input["url"]!)!,applicationURL:URL(fileURLWithPath:input["application"]!),configuration:config)
   print("completed")
  }catch{print("open-failed");exit(1)}
 }
}`);
await exec('xcrun',['swiftc','-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macos12.0`,'-swift-version','6','-parse-as-library',join(root,'native/OAuthBrowser.swift'),driver,'-o',binary],{timeout:30000});
const launch=input=>new Promise((resolve,reject)=>{const child=execFile(binary,[],{timeout:20000},(error,stdout,stderr)=>error?reject(Object.assign(error,{stdout,stderr})):resolve({stdout,stderr}));child.stdin.end(JSON.stringify(input));});
const completed=await launch({url:synthetic,application,runner});assert.match(completed.stdout,/completed/);
let receipt;for(let i=0;i<100;i++){try{receipt=JSON.parse(await readFile(result,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,50));}}
assert.equal(receipt?.matched,true);await new Promise(r=>setTimeout(r,500));assert.throws(()=>process.kill(receipt.pid,0),{code:'ESRCH'},'Isolated receiver exits itself');
await assert.rejects(launch({url:synthetic,application:join(temp,'missing.app'),runner}));
await assert.rejects(launch({url:'http://dcode-oauth-fixture.invalid/',application,runner}));
console.log(JSON.stringify({temp,productionOpener:true,explicitInstalledApplication:true,osCompletion:true,urlDelivery:true,invalidApplicationRejected:true,invalidSchemeRejected:true,defaultBrowserUntouched:true}));
