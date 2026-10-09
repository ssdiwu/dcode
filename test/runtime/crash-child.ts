import { PiExecutionSession } from '../../src/adapters/pi/index.ts';
import { controlledModels, until } from './fixtures.ts';

const directory = process.argv[2];
if (!directory || !process.send) throw new Error('This fixture requires an isolated directory and IPC parent');
const fixture = controlledModels();
const unit = await PiExecutionSession.open({ directory, cwd: process.argv[3], target: { workspaceId: 'space', taskId: 'task', sessionId: 'session' }, models: fixture.models, agent: { model: { provider: fixture.model.provider, modelId: fixture.model.id } } });
const request = { target: unit.target, operationId: 'crash', text: 'synthetic crash instruction', mode: 'steer', expected: (await unit.read()).control };
const receipt = await unit.submit(request);
await until(() => fixture.requests.length === 1);
process.send({ type: 'running', request, receipt });
// IPC 监听保持这个专用测试进程存活，由父测试发送 SIGKILL 验证真实异常退出。
process.on('message', () => undefined);
