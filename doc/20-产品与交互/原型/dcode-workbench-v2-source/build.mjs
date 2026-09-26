import { build } from "esbuild";
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const vendor = resolve(root, "vendor");
const packageRoot = resolve(root, "node_modules/@designcodeio/threeui");
const htmlPath = resolve(root, "../dcode-workbench-v2-prototype.html");
const bundle = JSON.parse(await readFile(resolve(vendor, "source-bundle.json"), "utf8"));
for (const file of bundle.files) {
  const source = await readFile(resolve(vendor, file.path));
  const hash = createHash("sha256").update(source).digest("hex");
  if (hash !== file.sha256) throw new Error(`Registered source changed: ${file.path}`);
}

const result = await build({
  absWorkingDir:root, entryPoints:["scene.tsx"], bundle:true, write:false,
  outdir:"dist", format:"iife", platform:"browser", target:"es2020",
  jsx:"automatic", minify:true, legalComments:"inline", metafile:true,
  define:{"process.env.NODE_ENV":'"production"'},
  plugins:[{
    name:"registered-threeui-source",
    setup(builder) {
      builder.onResolve({filter:/^@designcodeio\/threeui$/}, () => ({path:resolve(root,"index.ts")}));
      builder.onResolve({filter:/^@designcodeio\/threeui\/style\.css$/}, () => ({path:resolve(vendor,"src/shaders/threeui.css")}));
      // The registered collection also declares lazy imports for other variants.
      // Preserve them using the original published package, never placeholder code.
      builder.onResolve({filter:/^\.\.\//}, args => {
        if (!args.importer.startsWith(resolve(vendor,"src/shaders/structure-flow"))) return;
        return {path:resolve(packageRoot,"lib-dist/shaders/structure-flow",args.path+".js")};
      });
      // This shared stylesheet declares an unused font for other collections.
      // Keep its authored URL; Structure Flow does not use or request this font.
      builder.onResolve({filter:/\.woff2$/}, args => ({path:args.path,external:true}));
    },
  }],
});
const js = result.outputFiles.find(file=>file.path.endsWith(".js")).text;
const css = result.outputFiles.find(file=>file.path.endsWith(".css")).text;
const license = await readFile(resolve(packageRoot,"LICENSE"),"utf8");
await copyFile(resolve(packageRoot,"LICENSE"),resolve(vendor,"LICENSE"));
const inject = (html,name,content) => {
  const start=`<!-- threeui:${name}:start -->`,end=`<!-- threeui:${name}:end -->`;
  const a=html.indexOf(start),b=html.indexOf(end);
  if(a<0||b<a)throw new Error(`Missing ${name} integration markers`);
  return html.slice(0,a+start.length)+"\n"+content+"\n"+html.slice(b);
};
let html = await readFile(htmlPath,"utf8");
html = inject(html,"style",`<style>\n${css.replace(/<\/style/gi,"<\\/style")}\n</style>`);
html = inject(html,"script",`<script>\n/* ${license.replaceAll("*/","* /")} */\n${js.replace(/<\/script/gi,"<\\/script")}\n</script>`);
await writeFile(htmlPath,html);
await writeFile(resolve(root,"build-provenance.json"),JSON.stringify({
  source:"https://threeui.com/source-code/structure-flow.json",revision:"40eb5bac81e3",
  registeredFiles:bundle.files.map(({path,sha256})=>({path,sha256})),
  selectedRuntime:"three128 = three@0.128.0",configuredProps:{variant:"structure-flow",speed:1,pointSize:.08,opacity:.4,maskStart:.2,maskSolid:.5},
  inputs:Object.keys(result.metafile.inputs),
},null,2)+"\n");
console.log(`Verified ${bundle.files.length} exact source files; built ${js.length} JS bytes and ${css.length} CSS bytes into prototype.`);
