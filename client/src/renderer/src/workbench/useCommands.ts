import useSWR from 'swr';
import {api,errorText} from '../types';
import type {Workbench} from '../useWorkbench';
export interface ComposerCommand {name:string;description?:string;source:string}
export function useCommands(work:Workbench,enabled:boolean){
  const sessionId=work.session?.id,projectId=work.newProjectId;
  const {data,error,isLoading}=useSWR(enabled?['commands',sessionId,projectId,work.preferences?.disabledResources?.join('|')]:null,()=>api().request<{commands:ComposerCommand[]}>('dcodeSession.commands',{...(sessionId?{dcodeSessionId:sessionId}:projectId?{projectId}:{})}),{revalidateOnFocus:false,shouldRetryOnError:false,keepPreviousData:false});
  return {commands:data?.commands??[],error:error?errorText(error):'',loading:enabled&&isLoading};
}
