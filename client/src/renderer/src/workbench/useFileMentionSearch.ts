import { uiText } from "../../../shared/ui-language.ts";
import {useEffect,useState} from "react";
import {api,errorText} from "../types";

export interface FileMentionEntry {name:string;relativePath:string;reference:string;markdown:string}
interface SearchResult {key:string;entries:FileMentionEntry[];loading:boolean;error:string;scopeRequired:boolean;truncated:boolean}

export function useFileMentionSearch(input:{open:boolean;query:string;taskId?:string;projectId?:string|null;projectDirectory?:string;projectRevision?:number;hostDead:boolean}) {
  const {open,query,taskId,projectId,projectDirectory,projectRevision,hostDead}=input;
  const key=JSON.stringify([open,query,taskId,projectId,projectDirectory,projectRevision,hostDead]);
  const [result,setResult]=useState<SearchResult>({key:"",entries:[],loading:false,error:"",scopeRequired:false,truncated:false});
  useEffect(()=>{
    let active=true;
    if(!open)return()=>{active=false;};
    if(!taskId||!projectId){setResult({key,entries:[],loading:false,error:"",scopeRequired:true,truncated:false});return()=>{active=false;};}
    if(!query.trim()){setResult({key,entries:[],loading:false,error:"",scopeRequired:false,truncated:false});return()=>{active=false;};}
    if(query.length>120){setResult({key,entries:[],loading:false,error:uiText("文件名太长，请缩短搜索词"),scopeRequired:false,truncated:false});return()=>{active=false;};}
    if(hostDead){setResult({key,entries:[],loading:false,error:uiText("项目服务暂不可用，请稍后再试"),scopeRequired:false,truncated:false});return()=>{active=false;};}
    setResult({key,entries:[],loading:true,error:"",scopeRequired:false,truncated:false});
    const timer=setTimeout(()=>{
      void api().request<{scopeRequired?:boolean;entries:FileMentionEntry[];truncated?:boolean}>("workspace.fileSearch",{taskId,query,limit:40})
        .then(value=>{if(active)setResult({key,entries:value.entries??[],loading:false,error:"",scopeRequired:!!value.scopeRequired,truncated:!!value.truncated});})
        .catch(reason=>{if(active)setResult({key,entries:[],loading:false,error:errorText(reason),scopeRequired:false,truncated:false});});
    },120);
    return()=>{active=false;clearTimeout(timer);};
  },[key,open,query,taskId,projectId,hostDead]);
  return result.key===key?result:{entries:[],loading:open&&!!query.trim()&&!!taskId&&!!projectId,error:"",scopeRequired:open&&(!taskId||!projectId),truncated:false};
}
