export type CollaborationMessageState = "queued" | "delivering" | "completed" | "failed" | "paused" | "cancelled" | "interrupted";
export interface CollaborationMessage {
  id: string;
  taskId: string;
  originRawInputId: string;
  previousRawInputId?: string;
  acknowledgedUserMessageId?:string;
  deliveryMode?:"steer";
  targetSessionRunId?:string;
  pathAction?:import("./product-store.js").NativeSessionPathAction;
  sourceSessionId: string;
  targetSessionId: string;
  targetAgentRunId: string;
  author: "user" | "coordinator" | "member";
  text: string;
  attachmentIds?: string[];
  state: CollaborationMessageState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  completionReference?:{sessionRunId:string;agentRunId:string;reportId?:string;outcome:string;sourceMessageIds:string[]};
  resultReference?:{sessionRunId:string;agentRunId:string;reportId?:string;outcome:string;sourceMessageIds:string[]};
  reply?: string;
  error?: string;
  waitingFor?:"capacity"|"workspace";
}
