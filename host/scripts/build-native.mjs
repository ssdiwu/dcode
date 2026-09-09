import {spawnSync} from "node:child_process";
import {mkdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
const root=fileURLToPath(new URL("..",import.meta.url));
if(process.platform!=="darwin")throw new Error("D Code native file boundary requires macOS");
await mkdir(join(root,"dist/bin"),{recursive:true});
// Match the packaged Electron shell minimum instead of inheriting a local build target.
const nativeTarget=`${process.arch==="arm64"?"arm64":"x86_64"}-apple-macos12.0`;
const result=spawnSync("xcrun",["swiftc","-O","-target",nativeTarget,"-swift-version","6","-parse-as-library",join(root,"native/WorkspaceFiles.swift"),join(root,"native/FileHelper.swift"),"-o",join(root,"dist/bin/dcode-files")],{stdio:"inherit"});
if(result.error)throw result.error;
if(result.status!==0)throw new Error(`Native file boundary build failed (${result.status})`);

const auth=spawnSync("xcrun",["swiftc","-O","-target",nativeTarget,"-swift-version","6","-parse-as-library",join(root,"native/ModelCredentials.swift"),join(root,"native/OAuthBrowser.swift"),"-o",join(root,"dist/bin/dcode-model-credentials")],{stdio:"inherit"});
if(auth.error)throw auth.error;
if(auth.status!==0)throw new Error(`Native model credential boundary build failed (${auth.status})`);
