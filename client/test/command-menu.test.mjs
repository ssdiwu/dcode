import test from "node:test";
import assert from "node:assert/strict";
import { commandLabel, commandOptions, hasCommandArguments } from "../src/renderer/src/workbench/command-menu.ts";

test("skill display names do not replace canonical invocation names",()=>{
  const skill={name:"skill:507-breakdown",description:"视频拉片",source:"skill"};
  assert.equal(commandLabel(skill),"507 Breakdown");
  const [option]=commandOptions([skill],"breakdown");
  assert.equal(option.command,skill);
  assert.equal(option.command.name,"skill:507-breakdown");
  assert.equal(option.group,"skill");
  assert.equal(commandLabel({name:"skill:PDF-tools",source:"skill"}),"PDF Tools");
});
test("all supplied commands remain searchable, including past the old fifty-item cap",()=>{
  const commands=Array.from({length:169},(_,index)=>({name:`skill:workflow-${index}`,description:`真实说明 ${index}`,source:"skill"}));
  assert.equal(commandOptions(commands,"").length,169);
  assert.equal(commandOptions(commands,"skill:workflow-168")[0].command.name,"skill:workflow-168");
  assert.equal(commandOptions(commands,"Workflow 168")[0].command.name,"skill:workflow-168");
  assert.equal(commandOptions(commands,"真实说明 168")[0].command.name,"skill:workflow-168");
  assert.deepEqual(commandOptions(commands,"not-found"),[]);
});
test("type groups preserve canonical entries without inventing personal or project origin",()=>{
  const commands=[{name:"weekly-report",source:"prompt"},{name:"compact",source:"extension"},{name:"skill:507-fix",source:"skill"},{name:"status",source:"builtin"}];
  const options=commandOptions(commands,"");
  assert.deepEqual(options.map(option=>option.group),["skill","command","command","prompt"]);
  assert.deepEqual(options.map(option=>option.command.name),["skill:507-fix","compact","status","weekly-report"]);
  const duplicates=commandOptions([commands[2],commands[2]],"");
  assert.equal(duplicates.length,2);
  assert.notEqual(duplicates[0].key,duplicates[1].key);
});

test("readable search words are distinct from a known invocation's arguments",()=>{
  const commands=[{name:"compact",source:"extension"},{name:"skill:507-breakdown",source:"skill"}];
  assert.equal(hasCommandArguments("/507 Breakdown",commands),false);
  assert.equal(hasCommandArguments("/compact 保留内容",commands),true);
  assert.equal(hasCommandArguments("/skill:507-breakdown 参数",commands),true);
  assert.equal(hasCommandArguments("/compact-more",commands),false);
});
