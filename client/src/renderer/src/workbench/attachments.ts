import type { AttachmentSource } from "../types.ts";

export function fileType(name: string): string {
  const extension = name.includes(".") ? name.split(".").at(-1)! : "";
  return extension && extension.length <= 10 ? extension.toUpperCase() : "文件";
}
/** Local files are copied by Host; clipboard images have no OS path and use the image byte contract. */
export async function attachmentSource(file: File, pathForFile: (file: File) => string): Promise<AttachmentSource> {
  const path = pathForFile(file);
  if (path) return {path};
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error(`无法获取 ${file.name} 的本地路径，请从 Finder 拖入或通过附件菜单选择。`);
  if (!file.size || file.size > 5_000_000) throw new Error("图片需大于 0 字节且不超过 5 MB。");
  const data = await new Promise<string>((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = ()=>resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = ()=>reject(new Error(`${file.name} 读取失败，请重新添加。`));
    reader.onabort = ()=>reject(new Error(`${file.name} 读取已取消。`));
    reader.readAsDataURL(file);
  });
  return {name:file.name || "粘贴图片.png",data,mimeType:file.type};
}
