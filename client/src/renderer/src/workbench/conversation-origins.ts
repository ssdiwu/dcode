import type {MessageRow} from "../workbench.ts";

/** Generated runtime inputs have a native source identity. Keep their replies
 * separate from earlier human turns; show actual work instructions in children. */
export function projectConversationOrigins(rows:MessageRow[],inputs:readonly {sourceEntryId:string;author:string;messageId:string}[],child:boolean):MessageRow[]{
  const origins=new Map(inputs.map(input=>[input.sourceEntryId,input]));let group:string|undefined;
  return rows.flatMap(row=>{
    if(row.role==="user"){
      const origin=origins.get(row.id);
      group=origin&&origin.author!=="user"?origin.messageId:undefined;
      if(group)return child?[{...row,role:"coordination" as const,collaborationGroupId:group}]:[{id:`origin-${group}`,messageId:row.messageId,role:"process" as const,parts:[],collaborationGroupId:group,inputBoundary:true}];
    }
    return [{...row,...(group?{collaborationGroupId:group}:{})}];
  });
}
