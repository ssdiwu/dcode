import {blockedPreviewProxy} from "./preview-network.js";
import {protocol,session,WebContentsView,type BrowserWindow} from "electron";
import {randomUUID} from "node:crypto";
import type {HostBridge} from "../host/bridge.js";
protocol.registerSchemesAsPrivileged([{scheme:"dcode-preview",privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
interface PreviewInput {clientId:string;source:Record<string,string>;path:string;root:string;text:string;bounds:{x:number;y:number;width:number;height:number}}
interface ActivePreview {id:string;interactions:number;ready:Promise<void>;browserSession:ReturnType<typeof session.fromPartition>;document:PreviewInput;view:WebContentsView;url:string;network:boolean;blocked:boolean}
/** One opaque, non-persistent renderer per visible HTML buffer. It has no preload,
 * App IPC, filesystem APIs, dialogs, downloads, popups or persistent permissions. */
export class HTMLPreview {
  private active?:ActivePreview;
  private generation=0;
  private owner?:string;
  constructor(private readonly window:()=>BrowserWindow|null,private readonly bridge:()=>HostBridge|null,private readonly emit:(event:string,data:unknown)=>void){}
  async update(input:PreviewInput):Promise<{id:string;network:boolean;blocked:boolean}>{
    if(!input||typeof input.clientId!=="string"||input.clientId.length>100||typeof input.path!=="string"||typeof input.text!=="string"||!input.bounds)throw new Error("预览内容无效");
    const generation=++this.generation;this.owner=input.clientId;
    const window=this.window(),bridge=this.bridge();if(!window||!bridge)throw new Error("预览服务尚未连接");
    const preserveMainFocus=window.webContents.isFocused(),previous=this.active,interaction=previous?.interactions??0;
    try{await bridge.request("workspace.preview",{source:input.source,path:input.path,text:input.text,expectedRoot:input.root});}
    catch(error){if(generation===this.generation)await this.close(input.clientId);throw error;}
    if(generation!==this.generation||this.owner!==input.clientId)return {id:"",network:false,blocked:false};
    const key=JSON.stringify([input.source,input.path,input.root]);
    if(this.active&&JSON.stringify([this.active.document.source,this.active.document.path,this.active.document.root])!==key)await this.disposeActive();
    if(generation!==this.generation||this.owner!==input.clientId)return {id:"",network:false,blocked:false};
    if(!this.active){
      const id=randomUUID();const browserSession=session.fromPartition(`dcode-preview-${id}`,{cache:false});
      const view=new WebContentsView({webPreferences:{session:browserSession,sandbox:true,nodeIntegration:false,contextIsolation:true,webSecurity:true,disableDialogs:true,allowRunningInsecureContent:false}});
      const url=`dcode-preview://${id}/${input.path.split("/").map(encodeURIComponent).join("/")}`;
      const active:ActivePreview={id,interactions:0,ready:blockedPreviewProxy().then(proxy=>browserSession.setProxy(proxy)),browserSession,document:input,view,url,network:false,blocked:false};this.active=active;
      view.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
      browserSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
      browserSession.setPermissionCheckHandler(()=>false);
      browserSession.on("will-download",event=>event.preventDefault());
      browserSession.webRequest.onBeforeRequest({urls:["<all_urls>"]},(details,callback)=>{
        const scheme=new URL(details.url).protocol;
        const local=["dcode-preview:","data:","blob:","about:"].includes(scheme);
        const external=["http:","https:","ws:","wss:"].includes(scheme);
        const allowed=local||external&&active.network;
        if(!allowed){active.blocked=true;this.emit("preview.blocked",{id:active.id});}
        callback({cancel:!allowed});
      });
      browserSession.protocol.handle("dcode-preview",async request=>{
        if(this.active!==active)return new Response("Preview closed",{status:410});
        const address=new URL(request.url);if(address.hostname!==id)return new Response("Outside preview",{status:403});
        if(address.pathname===new URL(active.url).pathname){
          const remote=active.network?"http: https: ws: wss:":"";
          const csp=`default-src 'self' data: blob: ${remote}; script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: ${remote}; style-src 'self' 'unsafe-inline' ${remote}; connect-src 'self' ${remote}; form-action 'none'; base-uri 'self'`;
          return new Response(active.document.text,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-DNS-Prefetch-Control":"off","Content-Security-Policy":csp}});
        }
        try{
          const asset=await bridge.request<{base64:string;mimeType:string}>("workspace.asset",{source:active.document.source,path:decodeURIComponent(address.pathname.slice(1)),expectedRoot:active.document.root});
          if(this.active!==active)return new Response("Preview closed",{status:410});
          return new Response(new Uint8Array(Buffer.from(asset.base64,"base64")),{headers:{"Content-Type":asset.mimeType,"Cache-Control":"no-store","X-DNS-Prefetch-Control":"off","Content-Security-Policy":`default-src 'self' data: blob: ${active.network?"http: https: ws: wss:":""}; script-src 'self' 'unsafe-inline' 'unsafe-eval' ${active.network?"http: https:":""}; style-src 'self' 'unsafe-inline' ${active.network?"http: https:":""}; base-uri 'self'; form-action 'none'`}});
        }catch{return new Response("Local resource unavailable",{status:404});}
      });
      view.webContents.on("before-mouse-event",(_event,input)=>{if(input.type==="mouseDown"||input.type==="mouseWheel")active.interactions++;});
      view.webContents.on("before-input-event",()=>{active.interactions++;});
      view.webContents.setWindowOpenHandler(()=>({action:"deny"}));
      view.webContents.on("will-navigate",(event,target)=>{if(target.split("#")[0]!==active.url){event.preventDefault();active.blocked=true;this.emit("preview.navigationBlocked",{id});}});
      view.webContents.on("will-prevent-unload",event=>event.preventDefault());
      window.contentView.addChildView(view);
    }
    const active=this.active;try{await active.ready;}catch(error){if(this.active===active)await this.disposeActive();throw error;}
    if(generation!==this.generation||this.active!==active)return {id:"",network:false,blocked:false};
    const changed=active.document.text!==input.text;const first=active.view.webContents.getURL()==="";active.document=input;
    this.bounds(input.bounds,input.clientId);if(changed||first)await active.view.webContents.loadURL(active.url);
    if(preserveMainFocus&&window.isFocused()&&this.active===active&&generation===this.generation&&active.interactions===(previous===active?interaction:0))window.webContents.focus();
    return {id:active.id,network:active.network,blocked:active.blocked};
  }
  bounds(bounds:PreviewInput["bounds"],clientId?:string):void {
    if(clientId&&clientId!==this.owner)return;
    const active=this.active,window=this.window();if(!active||!window)return;
    if(!bounds||Object.values(bounds).some(value=>!Number.isFinite(value)||value<0||value>16384))throw new Error("预览位置无效");
    const zoom=window.webContents.getZoomFactor(),available=window.getContentBounds();
    const x=Math.round(bounds.x*zoom),y=Math.round(bounds.y*zoom);
    active.view.setBounds({x,y,width:Math.max(0,Math.min(Math.round(bounds.width*zoom),available.width-x)),height:Math.max(0,Math.min(Math.round(bounds.height*zoom),available.height-y))});
    active.view.setVisible(bounds.width>0&&bounds.height>0);
  }
  async allowNetwork(id:string,allow:boolean):Promise<void>{const active=this.active;if(!active||active.id!==id)throw new Error("预览已经改变");active.network=allow;active.blocked=false;await active.browserSession.setProxy(allow?{mode:"system"}:await blockedPreviewProxy());if(!allow)await active.browserSession.closeAllConnections();if(this.active===active)active.view.webContents.reload();}
  async close(clientId?:string):Promise<void>{
    if(clientId&&clientId!==this.owner)return;
    this.generation++;this.owner=undefined;await this.disposeActive();
  }
  private async disposeActive():Promise<void>{
    const active=this.active;if(!active)return;this.active=undefined;
    const window=this.window();if(window&&!window.isDestroyed())window.contentView.removeChildView(active.view);
    if(!active.view.webContents.isDestroyed())active.view.webContents.close({waitForBeforeUnload:false});
    active.browserSession.protocol.unhandle("dcode-preview");
    await Promise.all([active.browserSession.clearStorageData(),active.browserSession.clearCache(),active.browserSession.closeAllConnections()]);
  }
}
