/** Value types shared with the shell without bundling Host implementation. */
export interface ApiKeySubmission { id:string; providerId:string; apiKey:string }
export type ApiKeyConnectionResult = {ok:true} | {ok:false;code:"INVALID_INPUT"|"BUSY"|"UNAVAILABLE"|"FAILED"|"SYNC_REQUIRED"|"OUTCOME_UNKNOWN"};
