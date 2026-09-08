import type { FetchLike } from '../../http/client.js';
import { listProjects } from '../../http/projects.js';
import type { ProjectListPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { resolveProjectContext } from '../../project/context.js';

export interface ProjectListCommandOptions {
  json: boolean;
  page: number;
  limit: number;
  apiUrl?: string | undefined;
}

/**
 * 다른 거의 모든 명령이 요구하는 `--project` 에 넣을 id 를 찾는 자리.
 *
 * 참여 중인 프로젝트가 하나도 없어도 성공이다. 보고에 성공했으니 성공이고, `set -e` 스크립트가
 * 빈 목록에서 죽으면 안 된다.
 */
export async function runProjectList(
  options: ProjectListCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<void> {
  const context = await resolveProjectContext(env, options.apiUrl);
  const page = await listProjects(
    context.apiBaseUrl,
    context.cliToken,
    options.page,
    options.limit,
    fetchImpl,
  );

  const payload: ProjectListPayload = {
    items: page.items.map((item) => ({
      id: item.id,
      name: item.name,
      genre: item.genre,
      description: item.description,
      myRole: item.myRole,
      updatedAt: item.updatedAt,
    })),
    page: page.page,
    size: page.size,
    total: page.total,
  };

  if (options.json) {
    writeJsonPayload(sink, payload);
    return;
  }
  printProjectList(sink, payload);
}

function printProjectList(sink: OutputSink, payload: ProjectListPayload): void {
  if (payload.items.length === 0) {
    sink.out('No projects. Create one in the console, or ask to be invited to one.');
    return;
  }

  sink.out(`${String(payload.items.length)} of ${String(payload.total)} project(s).`);
  for (const item of payload.items) {
    sink.out(`  ${item.id.padStart(6)}  ${item.myRole.padEnd(8)}  ${item.name}`);
  }

  // 받은 것이 전부가 아니면 그렇게 말한다. 조용히 자르면 없는 프로젝트를 없다고 읽는다.
  const seen = payload.page * payload.size + payload.items.length;
  if (seen < payload.total) {
    sink.out(`${String(payload.total - seen)} more. Pass --page ${String(payload.page + 1)}.`);
  }
}
