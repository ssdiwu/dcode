export interface DiffLine {text:string;kind:"add"|"remove"|"context"|"header";oldLine?:number;newLine?:number;hunk?:string}
/** Preserve Git's two independent line counters; headers and EOF markers are not source lines. */
export function diffLines(diff:string):DiffLine[]{
  let old:number|undefined,next:number|undefined,hunk:string|undefined;
  return diff.split("\n").map(text=>{
    const match=text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
    if(match){old=Number(match[1]);next=Number(match[2]);hunk=text;return {text,kind:"header"};}
    if(text.startsWith("@@@")){old=undefined;next=undefined;hunk=undefined;}
    if(old!==undefined&&next!==undefined){
      if(text.startsWith("+")&&!text.startsWith("+++"))return {text,kind:"add",newLine:next++,hunk};
      if(text.startsWith("-")&&!text.startsWith("---"))return {text,kind:"remove",oldLine:old++,hunk};
      if(text.startsWith(" "))return {text,kind:"context",oldLine:old++,newLine:next++,hunk};
    }
    return {text,kind:"header"};
  });
}
