import type { ProviderConnection as Connection } from "../../../../../host/src/model-connections.js";
import type { ModelControls } from "../workbench/useModels";
import { LoaderCircle } from "lucide-react";

const labels:Record<Connection["state"],string>={
  refresh_pending:"登录待更新",timed_out:"登录已超时，请重试",sync_required:"连接已保存，目录更新失败",disconnected:"未连接",configured:"已配置",connected:"已连接",reconnect_required:"需要重新登录",awaiting_input:"请在安全窗口完成连接",awaiting_browser:"等待浏览器授权",saving:"正在保存连接",failed:"连接失败，请重试",cancelled:"已取消连接",
};
export function ProviderConnection({providerId,models}:{providerId:string;models:ModelControls}){
  const connection=models.connections?.providers.find(p=>p.providerId===providerId);
  if(!connection)return null;
  const pending=["awaiting_input","awaiting_browser","saving"].includes(connection.state);
  return <div className="provider-connection" aria-label={`${providerId} 连接`}>
    <div className="provider-connection-status"><span role="status">{pending&&<LoaderCircle className="connection-spinner" size={14}/>} {labels[connection.state]}</span>
      <span className="secondary">{connection.external?"使用外部连接；此处不会删除其认证。":connection.state==="configured"?"密钥已安全保存，首次请求时验证。":connection.state==="connected"?"连接已验证，模型权限由供应商决定。":connection.state==="refresh_pending"?"下次使用时自动更新授权。":pending?"完成后会自动返回，可随时取消授权步骤。":"密钥在本机安全窗口输入；浏览器登录由供应商完成。"}</span>
    </div>
    <div className="provider-connection-actions">
      {pending?connection.state!=="saving"&&<button className="text-button" onClick={()=>void models.cancelConnection(connection.flowId!)}>取消连接</button>:<>
        {connection.state==="sync_required"&&<button className="text-button" onClick={()=>void models.refreshConnections()}>重试更新</button>}
        {connection.methods.map(method=><button className="text-button" key={method.type} disabled={models.connecting} onClick={()=>void models.connect(providerId,method.type)}>{connection.managed?(method.type==="oauth"?"重新登录":"更换密钥"):method.label}</button>)}
        {connection.managed&&<button className="text-button" disabled={models.connecting} onClick={()=>void models.disconnect(providerId)}>断开 D Code 连接</button>}
        {!connection.methods.length&&!connection.managed&&<span className="secondary">使用系统环境或供应商配置连接。</span>}
      </>}
    </div>
  </div>;
}
