import test from "node:test";
import assert from "node:assert/strict";
import {fileMentionAt,insertFileMention} from "../src/renderer/src/workbench/file-mentions.ts";

test("file mention starts at an explicit input boundary and replaces only its own token",()=>{
  assert.equal(fileMentionAt("mail@example.com",16),null);
  assert.equal(fileMentionAt("echo $HOME",10),null);
  const text="查看 @src/old.ts 和后面的文字";
  const token=fileMentionAt(text,11);
  assert.deepEqual(token,{start:3,end:14,query:"src/old.ts"});
  const next=insertFileMention(text,token,"[src/new.ts](dcode-file:abc)");
  assert.equal(next.text,"查看 [src/new.ts](dcode-file:abc) 和后面的文字");
  assert.equal(next.caret,"查看 [src/new.ts](dcode-file:abc)".length);
});
