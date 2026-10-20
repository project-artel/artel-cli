/**
 * `@project-artel/cli/supervisor` 의 입구. desktop app(Electron)이 import 한다.
 *
 * 공유 계약 3절의 API 만 내보낸다. commander 를 import 하지 않고 stdout 에 쓰지 않는다 —
 * 모든 보고는 `onEvent` 로 나간다.
 */
export {
  logDir,
  stackStatus,
  startStack,
  stopStack,
  type RunningStack,
  type ServiceName,
  type ServiceState,
  type StackStatus,
  type SupervisorEvent,
  type SupervisorOptions,
} from './server/supervisor.js';
export { defaultDataDir } from './server/paths.js';
