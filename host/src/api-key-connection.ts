/** Private credential channel contract, separate from Protocol v1. */
export const MAX_API_KEY_LENGTH = 16_384;
export const MAX_API_KEY_FRAME_BYTES = 131_072;
import type {ApiKeySubmission,ApiKeyConnectionResult} from "./api-key-connection-types.js";
export type {ApiKeySubmission,ApiKeyConnectionResult} from "./api-key-connection-types.js";
export function validApiKeySubmission(value:unknown):value is ApiKeySubmission {
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const v=value as Record<string,unknown>;
  return Object.keys(v).length===3&&typeof v.id==="string"&&/^[a-z0-9-]{1,128}$/i.test(v.id)
    &&typeof v.providerId==="string"&&/^[a-z0-9][a-z0-9._-]{0,199}$/i.test(v.providerId)
    &&typeof v.apiKey==="string"&&v.apiKey.trim().length>0&&v.apiKey.length<=MAX_API_KEY_LENGTH;
}
export function safeApiKeyConnectionResult(value:unknown):ApiKeyConnectionResult {
  if(value&&typeof value==="object"){
    const v=value as Record<string,unknown>;
    if(v.ok===true)return {ok:true};
    if(v.ok===false&&typeof v.code==="string"&&["INVALID_INPUT","BUSY","UNAVAILABLE","FAILED","SYNC_REQUIRED","OUTCOME_UNKNOWN"].includes(v.code))return {ok:false,code:v.code as Extract<ApiKeyConnectionResult,{ok:false}>["code"]};
  }
  return {ok:false,code:"OUTCOME_UNKNOWN"};
}
