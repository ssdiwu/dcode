import {createServer,type Server} from "node:net";
let pending:Promise<number>|undefined;
let server:Server|undefined;
/** A non-forwarding loopback proxy complements request/CSP checks, including
 * non-HTTP browser transports. No bytes are inspected, logged or forwarded. */
export async function blockedPreviewProxy():Promise<Electron.ProxyConfig>{
  pending??=new Promise<number>((resolve,reject)=>{
    server=createServer(socket=>socket.destroy());
    server.once("error",reject);
    server.listen(0,"127.0.0.1",()=>{const address=server!.address();if(!address||typeof address==="string"){reject(new Error("无法建立隔离预览"));return;}server!.unref();resolve(address.port);});
  });
  return {mode:"fixed_servers",proxyRules:`socks5://127.0.0.1:${await pending}`,proxyBypassRules:"<-loopback>"};
}
export function closePreviewProxy():void{server?.close();server=undefined;pending=undefined;}
