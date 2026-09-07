const CREDENTIAL_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bhf_[A-Za-z0-9]{16,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bpypi-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@/gi,
  /\b(?=[A-Za-z0-9._~+/=-]{32,}\b)(?=[A-Za-z0-9._~+/=-]*[A-Z])(?=[A-Za-z0-9._~+/=-]*[a-z])(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{32,}\b/g,
];

// Host-memory-only exact values complement shape matching. Never serialize this
// registry: opaque custom keys and old tokens may be echoed by a late response.
const activeSecrets = new Set<string>();
let orderedSecrets:string[]=[];
export function rememberCredentialSecret(value:unknown):void {
  if(typeof value!=="string"||!value)return;
  const variants=[value,JSON.stringify(value).slice(1,-1),encodeURIComponent(value)];
  let changed=false;
  for(const secret of variants)if(secret&&!activeSecrets.has(secret)){activeSecrets.add(secret);changed=true;}
  if(changed)orderedSecrets=[...activeSecrets].sort((a,b)=>b.length-a.length);
}
export function rememberCredential(value:unknown):void {
  if(!value||typeof value!=="object")return;
  for(const [key,child] of Object.entries(value))if(/^(?:key|access|refresh|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret)$/i.test(key))rememberCredentialSecret(child);
}
export function rememberAuthInput(value:string):void {
  rememberCredentialSecret(value);
  try{const url=new URL(value);for(const name of ["code","token","access_token","refresh_token"])rememberCredentialSecret(url.searchParams.get(name));}catch{/* A provider may accept a bare code or code#state. */}
  if(!value.includes("://")&&value.includes("#"))rememberCredentialSecret(value.split("#")[0]);
}
export function rememberRequestCredentials(input:RequestInfo|URL,init?:RequestInit):void {
  const headers=new Headers(input instanceof Request?input.headers:undefined);
  new Headers(init?.headers).forEach((value,key)=>headers.set(key,value));
  headers.forEach((value,key)=>{if(/(?:^|-)authorization$|(?:^|-)api[-_]?key$/i.test(key)){rememberCredentialSecret(value);rememberCredentialSecret(value.replace(/^Bearer\s+/i,""));}});
  try{const url=new URL(input instanceof Request?input.url:String(input));for(const name of ["key","api_key","api-key","access_token"])rememberCredentialSecret(url.searchParams.get(name));}catch{/* Relative or provider-private request objects are not a credential source. */}
}

export function redactCredentialText(source: string, options: {opaqueTokens?:boolean} = {}): { text: string; redacted: boolean } {
  let text = source;
  for(const secret of orderedSecrets)text=text.split(secret).join("[REDACTED]");
  text = text.replace(/("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|client[_-]?secret|secret)"\s*:\s*")((?:\\.|[^"\\]){8,})(")/gi,"$1[REDACTED]$3");
  if(/"type"\s*:\s*"(?:api_key|oauth)"/iu.test(text))text=text.replace(/("(?:key|access|refresh)"\s*:\s*")([^"\\]{16,})(")/g,"$1[REDACTED]$3");
  for (const [index,pattern] of CREDENTIAL_PATTERNS.entries()) {
    if(index===CREDENTIAL_PATTERNS.length-1){if(options.opaqueTokens===false)continue;text=text.replace(pattern,(match:string,offset:number,whole:string)=>match.includes("/")&&(whole[offset-1]==="/"||/\/[^/]+\.[a-z]{1,6}$/iu.test(match))?match:"[REDACTED]");}
    else text=text.replace(pattern,"[REDACTED]");
  }
  return { text, redacted: text !== source };
}

export function containsCredentialMaterial(source: string): boolean {
  return redactCredentialText(source).redacted;
}
