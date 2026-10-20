import { CliError } from '../../errors.js';
import { SupervisorError } from '../../server/errors.js';
import { defaultDataDir } from '../../server/paths.js';

/** supervisor 는 `CliError` 를 모른다. 명령의 경계에서 같은 `code` 로 옮긴다. */
export async function withSupervisorErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SupervisorError) throw new CliError(error.code, error.message);
    throw error;
  }
}

export function commandDataDir(env: NodeJS.ProcessEnv): string {
  return defaultDataDir(env);
}
