import {readFileSync} from "node:fs";
import {dirname,resolve,sep} from "node:path";
import {fileURLToPath} from "node:url";
import ts from "typescript";

// 0.0.36 shared UI may use D Code client contracts, but must not acquire a
// second Agent Runtime, Pi TUI, product store, or direct native write path.
const clientRoot=resolve(fileURLToPath(new URL("../src/renderer/src/",import.meta.url)));
const sharedUi=new Set([resolve(clientRoot,"../../shared/ui-language"),resolve(clientRoot,"../../shared/ui-catalog")]);
const imageTypes=resolve(clientRoot,"../../../../host/src/image-generation-types");
const files=[
  "App.tsx","useWorkbench.ts","components/Composer.tsx",
  "components/ComposerAddMenu.tsx","components/ContextUsage.tsx",
  "components/TaskGoalEditor.tsx","components/TaskWorkflowPanel.tsx",
  "components/ImageGenerationPanel.tsx",
  "components/TeamOverview.tsx","components/conversation/ConversationRail.tsx",
  "components/conversation/ExecutionProcess.tsx",
  "workbench/context-usage.ts","workbench/file-mentions.ts",
  "workbench/team-overview.ts","workbench/useFileMentionSearch.ts",
  "../../shared/ui-language.ts","../../shared/ui-catalog.ts",
];
const allowedPackages=new Set([
  "react","react-dom","lucide-react","@radix-ui/react-dropdown-menu",
  "@floating-ui/react-dom","motion/react","zustand","swr",
]);
const errors=[];
for(const file of files){
  const path=resolve(clientRoot,file);
  const source=ts.createSourceFile(path,readFileSync(path,"utf8"),ts.ScriptTarget.Latest,true,
    path.endsWith(".tsx")?ts.ScriptKind.TSX:ts.ScriptKind.TS);
  const inspect=(specifier,node)=>{
    if(specifier.startsWith(".")){
      const target=resolve(dirname(path),specifier);
      const contractOnly=target.replace(/\.(?:js|ts)$/u,"")===imageTypes&&ts.isImportDeclaration(node)&&node.importClause?.isTypeOnly;
      if(target!==clientRoot&&!target.startsWith(clientRoot+sep)&&!sharedUi.has(target.replace(/\.(?:js|ts)$/u,""))&&!contractOnly)
        errors.push(`${file}:${source.getLineAndCharacterOfPosition(node.pos).line+1} imports outside the D Code renderer: ${specifier}`);
    }else if(!allowedPackages.has(specifier)){
      errors.push(`${file}:${source.getLineAndCharacterOfPosition(node.pos).line+1} imports an unapproved runtime package: ${specifier}`);
    }
  };
  const visit=node=>{
    if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))
      inspect(node.moduleSpecifier.text,node);
    if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword&&node.arguments.length===1){
      const value=node.arguments[0];
      if(!ts.isStringLiteral(value))errors.push(`${file}:${source.getLineAndCharacterOfPosition(node.pos).line+1} has a dynamic import target`);
      else inspect(value.text,node);
    }
    ts.forEachChild(node,visit);
  };
  visit(source);
}
if(errors.length){for(const error of errors)process.stderr.write(`${error}\n`);process.exitCode=1;}
else process.stdout.write(`D Code shared renderer boundary: ${files.length} modules verified\n`);
