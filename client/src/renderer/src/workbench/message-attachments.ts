import type { MessageRow, MessagePart } from "../workbench.ts";
import type { DCodeSessionPresentation } from "../types.ts";

/** The original user text and owned attachment references replace adapter-only path expansion. */
export function projectMessageAttachments(rows:MessageRow[],submissions:DCodeSessionPresentation["submissions"]):MessageRow[] {
  const used=new Set<number>();
  return rows.map(row=>{
    if(row.role!=="user")return row;
    const text=row.parts.filter(part=>part.kind==="text").map(part=>part.text).join("");
    const index=submissions?.findIndex((submission,index)=>!used.has(index)&&submission.effectiveText===text)??-1;
    if(index<0||!submissions)return row;
    used.add(index);
    const submission=submissions[index];
    const images=row.parts.filter(part=>part.kind==="image");
    let imageIndex=0;
    const parts:MessagePart[]=submission.text?[{kind:"text",text:submission.text}]:[];
    for(const attachment of submission.attachments){
      const image=attachment.mimeType.startsWith("image/")?images[imageIndex++]:undefined;
      parts.push(image?{...image,attachment}:{kind:"file",text:attachment.name,attachment});
    }
    return {...row,parts};
  });
}
