import test from "node:test";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

test("an external atomic replacement inside the save window is preserved",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-native-race-"));const run=promisify(execFile);
  try {
    const executable=join(root,"file-race");
    await run("xcrun",["swiftc","-O","-swift-version","6","-parse-as-library",fileURLToPath(new URL("../../native/WorkspaceFiles.swift",import.meta.url)),fileURLToPath(new URL("../../native/FileRaceTest.swift",import.meta.url)),"-o",executable],{timeout:60000});
    await run(executable,[],{timeout:10000});
  } finally {await rm(root,{recursive:true,force:true});}
});
