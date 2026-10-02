import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

const read=(relative)=>readFileSync(fileURLToPath(new URL(relative,import.meta.url)),"utf8");
const client=JSON.parse(read("../package.json"));
const clientLock=JSON.parse(read("../package-lock.json"));
const host=JSON.parse(read("../../host/package.json"));
const hostLock=JSON.parse(read("../../host/package-lock.json"));
const hostSource=read("../../host/src/pi-host.ts");
const hostTest=read("../../host/test/pi-host.test.ts");
const handshake=/const HOST_VERSION = "([^"]+)";/.exec(hostSource)?.[1];
const asserted=/assert\.equal\(hello\.hostVersion, "([^"]+)"\)/.exec(hostTest)?.[1];
const expected=client.version;
const actual={
  "client lockfile":clientLock.version,
  "client lockfile root package":clientLock.packages?.[""]?.version,
  "Host manifest":host.version,
  "Host lockfile":hostLock.version,
  "Host lockfile root package":hostLock.packages?.[""]?.version,
  "Host handshake":handshake,
  "Host handshake test":asserted,
};
const mismatches=Object.entries(actual).filter(([,version])=>version!==expected);
if(process.argv.includes("--require-target")&&!process.env.DCODE_EXPECTED_VERSION)
  mismatches.push(["declared build target","missing (set DCODE_EXPECTED_VERSION)"]);
if(process.env.DCODE_EXPECTED_VERSION&&process.env.DCODE_EXPECTED_VERSION!==expected)
  mismatches.push(["declared build target",process.env.DCODE_EXPECTED_VERSION]);
if(mismatches.length){
  for(const [name,version] of mismatches)
    process.stderr.write(`${name}: ${version??"missing"}; expected ${expected}\n`);
  process.exitCode=1;
}else process.stdout.write(`D Code App / Host / locks / handshake: ${expected}\n`);
