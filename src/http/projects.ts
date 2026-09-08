import { CliError } from '../errors.js';
import type { FetchLike } from './client.js';
import { parseHttpFailure, toCliError } from './errors.js';

const REQUEST_TIMEOUT_MS = 15_000;

export const PROJECTS_PATH = '/api/projects';

/**
 * 서버가 받는 최대 페이지 크기. `ProjectController.list` 의 `size` 가 100 에서 잘린다.
 * 여기서 알고 있어야 `--limit` 이 101 일 때 서버 왕복 없이 거절할 수 있다.
 */
export const MAX_PROJECT_PAGE_SIZE = 100;

/** `ProjectSummaryResponse`(orchestration)에서 이 CLI 가 쓰는 부분. */
export interface ProjectSummary {
  id: string;
  name: string;
  genre: string;
  description: string | null;
  myRole: string;
  updatedAt: string;
}

/** `ProjectPageResponse`(orchestration)와 같은 모양. */
export interface ProjectPage {
  items: ProjectSummary[];
  page: number;
  size: number;
  total: number;
}

/**
 * 참여 중인 프로젝트를 최근 수정순으로 받는다.
 *
 * `scope` 는 보내지 않는다. 서버 기본값이 `MINE` 이고 `ALL` 은 개발자 등급 전용이라, CLI 가
 * 그것을 보내면 등급이 안 되는 사용자에게는 실패로만 나타난다.
 */
export async function listProjects(
  apiBaseUrl: string,
  cliToken: string,
  page: number,
  size: number,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<ProjectPage> {
  const query = new URLSearchParams({ page: String(page), size: String(size) });
  const endpoint = `${apiBaseUrl}${PROJECTS_PATH}?${query.toString()}`;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { authorization: `Bearer ${cliToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CliError(
      'network_error',
      `Could not reach ${endpoint}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  const body = await readBodyText(response);
  if (!response.ok) {
    throw toCliError(endpoint, parseHttpFailure(response.status, body));
  }

  return parseProjectPage(body, endpoint);
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseProjectPage(body: string, endpoint: string): ProjectPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new CliError('server_error', `${endpoint} answered with a body that is not valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError(
      'server_error',
      `${endpoint} answered with a body that is not a JSON object.`,
    );
  }

  const envelope = parsed as { items?: unknown; page?: unknown; size?: unknown; total?: unknown };
  if (!Array.isArray(envelope.items)) {
    throw new CliError('server_error', `${endpoint} answered without an "items" array.`);
  }

  return {
    items: envelope.items.map((item, index) => parseProject(item, index, endpoint)),
    page: requireNumber(envelope.page, 'page', endpoint),
    size: requireNumber(envelope.size, 'size', endpoint),
    total: requireNumber(envelope.total, 'total', endpoint),
  };
}

function parseProject(value: unknown, index: number, endpoint: string): ProjectSummary {
  if (typeof value !== 'object' || value === null) {
    throw new CliError(
      'server_error',
      `${endpoint} answered with "items[${String(index)}]" that is not a JSON object.`,
    );
  }
  const fields = value as Partial<Record<keyof ProjectSummary, unknown>>;
  const at = (field: string): string => `items[${String(index)}].${field}`;
  return {
    id: requireString(fields.id, at('id'), endpoint),
    name: requireString(fields.name, at('name'), endpoint),
    genre: requireString(fields.genre, at('genre'), endpoint),
    description: requireNullableString(fields.description, at('description'), endpoint),
    myRole: requireString(fields.myRole, at('myRole'), endpoint),
    updatedAt: requireString(fields.updatedAt, at('updatedAt'), endpoint),
  };
}

function requireString(value: unknown, field: string, endpoint: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliError('server_error', `${endpoint} answered without a string "${field}" field.`);
  }
  return value;
}

function requireNullableString(value: unknown, field: string, endpoint: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new CliError(
      'server_error',
      `${endpoint} answered with a "${field}" field that is neither a string nor null.`,
    );
  }
  return value;
}

function requireNumber(value: unknown, field: string, endpoint: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CliError('server_error', `${endpoint} answered without a numeric "${field}" field.`);
  }
  return value;
}
