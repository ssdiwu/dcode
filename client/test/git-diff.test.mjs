import test from 'node:test';
import assert from 'node:assert/strict';
import {diffLines} from '../src/renderer/src/workbench/git-diff.ts';
test('Git references keep old and new line coordinates across hunks and skip metadata',()=>{
  const rows=diffLines('--- a/note.md\n+++ b/note.md\n@@ -3,2 +3,3 @@\n same\n-old\n+new\n+more\n\\ No newline at end of file\n@@ -10 +11 @@\n-x\n+y');
  assert.deepEqual(rows.filter(row=>row.kind!=='header').map(row=>[row.kind,row.oldLine,row.newLine]),[['context',3,3],['remove',4,undefined],['add',undefined,4],['add',undefined,5],['remove',10,undefined],['add',undefined,11]]);
  assert.ok(rows.filter(row=>row.kind!=='header').every(row=>row.hunk?.startsWith('@@')));
});
