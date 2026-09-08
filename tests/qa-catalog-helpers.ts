import http from 'node:http';

export interface FakeCatalogServer {
  baseUrl: string;
  paths: string[];
  close(): Promise<void>;
}

/**
 * 서버가 실제로 내보내는 모양이다. DTO 의 `@JsonAlias("min_tokens")` 는 읽을 때만 듣고,
 * Jackson 이 내보낼 때는 property 이름 `minTokens` 를 쓴다 — snake_case 로 적은 fake 는 CLI 가
 * 못 읽는 것을 못 읽는다고 알려 주지 못한다.
 */
export const MODELS = [
  {
    id: 'openai/gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    provider: 'openai',
    supportsStrictJson: true,
    supportsVision: true,
    inputModalities: ['text', 'image'],
    multimodal: true,
    reasoning: {
      kind: 'effort',
      efforts: ['low', 'medium', 'high'],
      minTokens: null,
      maxTokens: null,
      step: null,
    },
  },
  {
    id: 'anthropic/claude-haiku',
    label: 'Claude Haiku',
    provider: 'anthropic',
    supportsStrictJson: true,
    supportsVision: true,
    inputModalities: ['text', 'image'],
    multimodal: true,
    reasoning: null,
  },
];

export async function startFakeCatalogServer(labels: string[] = []): Promise<FakeCatalogServer> {
  const paths: string[] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    paths.push(request.url ?? '/');
    response.setHeader('content-type', 'application/json');

    if (url.pathname === '/api/qa-models') {
      response.writeHead(200);
      response.end(JSON.stringify(MODELS));
      return;
    }
    if (url.pathname === '/api/qa-stats/labels') {
      response.writeHead(200);
      response.end(
        JSON.stringify({ projectId: url.searchParams.get('projectId'), labels }),
      );
      return;
    }
    response.writeHead(404);
    response.end('{"code":"not_found","message":"no such endpoint"}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fake catalog server did not bind a port');
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    paths,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

