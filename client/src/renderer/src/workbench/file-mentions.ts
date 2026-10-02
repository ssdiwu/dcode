export interface FileMentionToken {start:number;end:number;query:string}

/** A file mention is a token at the caret, never an email address or a substring elsewhere. */
export function fileMentionAt(text:string,caret:number):FileMentionToken|null {
  if(caret<0||caret>text.length)return null;
  const before=text.slice(0,caret);
  const match=/(^|\s)@([^\s@]*)$/u.exec(before);
  if(!match)return null;
  const start=match.index+match[1].length;
  let end=caret;
  while(end<text.length&&!/[\s@]/u.test(text[end]!))end++;
  return {start,end,query:text.slice(start+1,end)};
}

export function insertFileMention(text:string,token:FileMentionToken,markdown:string):{text:string;caret:number} {
  const inserted=markdown+(/\s/u.test(text[token.end]??"")?"":" ");
  return {text:text.slice(0,token.start)+inserted+text.slice(token.end),caret:token.start+inserted.length};
}
