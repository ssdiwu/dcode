import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import * as childProcess from 'node:child_process';import{syncBuiltinESMExports}from'node:module';import{promisify}from'node:util';import{mkdtemp,writeFile,rm}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';import{fileURLToPath}from'node:url';import{createHash}from'node:crypto';
const exec=promisify(execFile),host=fileURLToPath(new URL('../..',import.meta.url)),temp=await mkdtemp(join(tmpdir(),'dcode-keychain-access-')),dataRoot=join(temp,'.dcode'),service='com.dcode.model-auth.'+createHash('sha256').update(dataRoot).digest('hex'),provider='isolated-keychain-test';
const driver=join(temp,'driver.swift'),binary=join(temp,'owner');await writeFile(driver,`import Foundation
import Security
@main struct Owner {
 static func main() throws {
  let input=try JSONSerialization.jsonObject(with:FileHandle.standardInput.readDataToEndOfFile()) as! [String:String]
  var before:DarwinBoolean=true;SecKeychainGetUserInteractionAllowed(&before)
  let status:OSStatus=try withKeychainInteraction(false) {
   var q:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:input["service"]!,kSecAttrAccount as String:input["provider"]!]
   if input["action"]=="delete" {return SecItemDelete(q as CFDictionary)}
   q[kSecValueData as String]=Data("{\\"type\\":\\"api_key\\",\\"key\\":\\"isolated-fake-only\\"}".utf8)
   q[kSecAttrGeneric as String]=Data("api_key".utf8);q[kSecAttrLabel as String]="D Code TEST isolated credential"
   return SecItemAdd(q as CFDictionary,nil)
  }
  var after:DarwinBoolean=true;SecKeychainGetUserInteractionAllowed(&after)
  print(String(data:try JSONSerialization.data(withJSONObject:["status":status,"interactionRestored":before.boolValue==after.boolValue]),encoding:.utf8)!)
 }
}`);
await exec('xcrun',['swiftc','-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macos12.0`,'-swift-version','6','-parse-as-library',join(host,'native/KeychainInteraction.swift'),driver,'-o',binary],{timeout:30000});
const owner=action=>new Promise((resolve,reject)=>{const c=execFile(binary,[],{timeout:8000},(error,stdout)=>error?reject(error):resolve(JSON.parse(stdout)));c.stdin.end(JSON.stringify({service,provider,action}));});
const created=await owner('create');assert.equal(created.status,0,'The isolated test item must be created without UI');assert.equal(created.interactionRestored,true);
const pids=[],transactionPids=[];const spawn=childProcess.default.spawn;childProcess.default.spawn=(...args)=>{const child=spawn(...args);if(String(args[0]).endsWith('dcode-model-credentials')){pids.push(child.pid);const write=child.stdin.write;child.stdin.write=function(chunk,...rest){try{if(JSON.parse(String(chunk)).operation==='transaction')transactionPids.push(child.pid);}catch{}return write.call(this,chunk,...rest);};}return child;};syncBuiltinESMExports();
const{MacCredentialAdapter,DCodeCredentialStore,SecureCredentialError}=await import(join(host,'dist/src/secure-model-credentials.js'));
const adapter=new MacCredentialAdapter(dataRoot),credentials=new DCodeCredentialStore(adapter,join(temp,'external.json'));let reads=0;const transaction=adapter.transaction.bind(adapter);adapter.transaction=(...args)=>{reads++;return transaction(...args);};
try{
 const metadata=await credentials.connectionMetadata(provider);assert.equal(metadata.type,'api_key');assert.equal(reads,0);
 const results=await Promise.allSettled(Array.from({length:20},()=>credentials.read(provider)));assert.equal(reads,1);
 for(const result of results){assert.equal(result.status,'rejected');assert.ok(result.reason instanceof SecureCredentialError);assert.ok(['access_required','access_denied'].includes(result.reason.code));}
 await Promise.allSettled(Array.from({length:20},()=>credentials.read(provider)));assert.equal(reads,1,'Denied access is not automatically retried');
 assert.equal((await owner('delete')).status,0);
 // Re-create only this fixture with the production helper as its authorized owner.
 // No existing ACL is broadened and no user item is read or changed.
 await adapter.transaction(provider,async()=>({value:undefined,write:{type:'api_key',key:'replacement-fake-only'}}));
 const authorizedPid=transactionPids.at(-1);await credentials.authorize(provider,new AbortController().signal);
 for(let i=0;i<5;i++)assert.equal((await credentials.read(provider)).key,'replacement-fake-only');assert.equal(transactionPids.at(-1),authorizedPid,'One private helper serves authorized subsequent reads');
 await adapter.transaction(provider,async()=>({value:undefined,write:null}));
 console.log(JSON.stringify({temp,realFileBasedKeychain:true,isolatedFakeItem:true,metadataSecretReads:0,concurrentDeniedReads:1,denialDoesNotRetry:true,crossIdentityAccessDenied:true,interactionRestored:true,authorizedRepeatedReads:true,privateHelperReused:true,userItemOrAclTouched:false}));
}finally{
 try{await adapter.transaction(provider,async()=>({value:undefined,write:null}));}catch{}
 credentials.close();childProcess.default.spawn=spawn;syncBuiltinESMExports();await owner('delete');
}
