import { CliError, UsageError } from '../errors.js';

// CLI와 MCP는 같은 skill revision을 읽는다. 안내 업데이트는 별도 검토한 commit으로 고정한다.
export const SKILLS_REVISION = '475b6a1b79bad90a4c89d0b76a5d1fc1c660addf';
const ROOT = `https://raw.githubusercontent.com/project-artel/artel-skills/${SKILLS_REVISION}/`;
const TIMEOUT_MS = 10_000;

export interface GuideTopic {
  id: string;
  title: string;
  path: string;
  references: string[];
}
export interface GuideCatalog {
  schemaVersion: 1;
  topics: GuideTopic[];
}
export interface GuideListPayload extends GuideCatalog {
  revision: string;
  source: string;
}
export interface GuideDocumentPayload {
  topic: GuideTopic;
  revision: string;
  source: string;
  content: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function safeReference(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^references\/[A-Za-z0-9_./-]+$/.test(value) &&
    !value.split('/').some((part) => part === '..' || part === '.' || part === '')
  );
}
export function parseGuideCatalog(value: unknown): GuideCatalog {
  if (!object(value) || value['schemaVersion'] !== 1 || !Array.isArray(value['topics'])) {
    throw new CliError('server_error', 'The skill catalog has an unsupported format.');
  }
  const topics: GuideTopic[] = [];
  const seen = new Set<string>();
  for (const item of value['topics']) {
    if (
      !object(item) ||
      typeof item['id'] !== 'string' ||
      !/^artel-[a-z0-9-]+$/.test(item['id']) ||
      seen.has(item['id']) ||
      typeof item['title'] !== 'string' ||
      item['path'] !== `skills/${item['id']}/SKILL.md` ||
      !Array.isArray(item['references']) ||
      !item['references'].every(safeReference)
    ) {
      throw new CliError('server_error', 'The skill catalog contains an invalid topic.');
    }
    seen.add(item['id']);
    topics.push({
      id: item['id'],
      title: item['title'],
      path: item['path'],
      references: item['references'],
    });
  }
  return { schemaVersion: 1, topics };
}

async function read(path: string, fetchImpl: typeof fetch): Promise<string> {
  try {
    const response = await fetchImpl(`${ROOT}${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    const body = await response.text();
    if (body.length > 500_000) throw new Error('Document exceeds 500000 characters');
    return body;
  } catch (error) {
    throw new CliError(
      'network_error',
      `Could not read the skill guide at revision ${SKILLS_REVISION}: ${error instanceof Error ? error.message : 'request failed'}`,
    );
  }
}

export async function listGuides(fetchImpl: typeof fetch = fetch): Promise<GuideListPayload> {
  const body = await read('knowledge/catalog.json', fetchImpl);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new CliError('server_error', 'The skill catalog is not valid JSON.');
  }
  return {
    ...parseGuideCatalog(parsed),
    revision: SKILLS_REVISION,
    source: `${ROOT}knowledge/catalog.json`,
  };
}

export async function showGuide(
  topicId: string,
  reference?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GuideDocumentPayload> {
  const catalog = await listGuides(fetchImpl);
  const topic = catalog.topics.find((item) => item.id === topicId);
  if (!topic) throw new UsageError(`Unknown guide "${topicId}". Run artel guide list.`);
  if (reference !== undefined && !topic.references.includes(reference)) {
    throw new UsageError(
      `Unknown reference "${reference}" for ${topicId}. Available: ${topic.references.join(', ') || 'none'}`,
    );
  }
  const path = reference === undefined ? topic.path : `skills/${topic.id}/${reference}`;
  return {
    topic,
    revision: SKILLS_REVISION,
    source: `${ROOT}${path}`,
    content: await read(path, fetchImpl),
  };
}
