import type { ControlToken, ExecutionTarget, ExecutionView, InputReceipt } from '@/contracts/index.ts';

/** 宿主核对任务/成员授权后调用；这里不接受第二份输入队列。 */
export interface ExecutionPort {
  readonly target: ExecutionTarget;
  read(): Promise<ExecutionView>;
  submit(input: unknown): Promise<InputReceipt>;
  lookupReceipt(input: unknown): Promise<InputReceipt>;
  pause(): Promise<ExecutionView>;
  resume(expected: ControlToken): Promise<ExecutionView>;
  close(): Promise<void>;
}
