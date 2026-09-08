import { describe, expect, it } from 'vitest';

import {
  effectiveApiBaseUrl,
  resolveApiBaseUrl,
  resolveConfig,
  resolveConsoleBaseUrl,
} from '../src/config.js';
import type { CliError } from '../src/errors.js';

describe('resolveApiBaseUrl', () => {
  it('lets --api-url win over ARTEL_API_BASE_URL', () => {
    const url = resolveApiBaseUrl(
      { ARTEL_API_BASE_URL: 'https://env.example.test' },
      'https://flag.example.test',
    );
    expect(url).toBe('https://flag.example.test');
  });

  it('takes the flag alone when there is no environment variable', () => {
    const url = resolveApiBaseUrl({}, 'https://flag.example.test');
    expect(url).toBe('https://flag.example.test');
  });

  it('normalizes a trailing slash on the flag value the same way it does for the environment variable', () => {
    expect(resolveApiBaseUrl({}, 'https://flag.example.test/')).toBe(
      'https://flag.example.test',
    );
    expect(resolveApiBaseUrl({ ARTEL_API_BASE_URL: 'https://env.example.test/' })).toBe(
      'https://env.example.test',
    );
  });

  it('falls back to the address the credentials file was written with', () => {
    expect(resolveApiBaseUrl({}, undefined, 'https://stored.example.test')).toBe(
      'https://stored.example.test',
    );
  });

  it('lets ARTEL_API_BASE_URL win over the stored address', () => {
    expect(
      resolveApiBaseUrl(
        { ARTEL_API_BASE_URL: 'https://env.example.test' },
        undefined,
        'https://stored.example.test',
      ),
    ).toBe('https://env.example.test');
  });

  it('lets --api-url win over both', () => {
    expect(
      resolveApiBaseUrl(
        { ARTEL_API_BASE_URL: 'https://env.example.test' },
        'https://flag.example.test',
        'https://stored.example.test',
      ),
    ).toBe('https://flag.example.test');
  });

  /**
   * `ARTEL_TOKEN` 으로 인증한 쪽이 `null` 을 넘긴다. 그 경로가 실제로 주소 없이 끝나는지
   * 본다 — 빈 문자열이나 공백만 든 값을 값으로 읽으면 CI 가 엉뚱한 곳에 붙는다.
   */
  it('treats a blank stored address as absent', () => {
    const failure = (() => {
      try {
        resolveApiBaseUrl({}, undefined, '   ');
        return null;
      } catch (error) {
        return error as CliError;
      }
    })();

    expect(failure?.code).toBe('missing_api_base_url');
  });

  it('names the credentials file when the stored address is malformed', () => {
    const failure = (() => {
      try {
        resolveApiBaseUrl({}, undefined, 'not-a-url');
        return null;
      } catch (error) {
        return error as CliError;
      }
    })();

    expect(failure?.code).toBe('invalid_base_url');
    expect(failure?.message).toContain('credentials file');
  });

  it('still refuses when neither --api-url nor the environment variable is set', () => {
    const failure = (() => {
      try {
        resolveApiBaseUrl({});
        return null;
      } catch (error) {
        return error as CliError;
      }
    })();

    expect(failure?.code).toBe('missing_api_base_url');
    expect(failure?.message).toContain('--api-url');
    expect(failure?.message).toContain('ARTEL_API_BASE_URL');
  });

  it('points at "artel auth login" when nothing supplies an address', () => {
    const failure = (() => {
      try {
        resolveApiBaseUrl({});
        return null;
      } catch (error) {
        return error as CliError;
      }
    })();

    expect(failure?.message).toContain('artel auth login');
  });

  it('rejects a malformed --api-url instead of failing later as a network error', () => {
    const failure = (() => {
      try {
        resolveApiBaseUrl({}, 'not-a-url');
        return null;
      } catch (error) {
        return error as CliError;
      }
    })();

    expect(failure?.code).toBe('invalid_base_url');
    expect(failure?.message).toContain('--api-url');
  });

  it('rejects a non-http(s) --api-url such as ftp://', () => {
    const failure = (() => {
      try {
        resolveApiBaseUrl({}, 'ftp://example.test');
        return null;
      } catch (error) {
        return error as CliError;
      }
    })();

    expect(failure?.code).toBe('invalid_base_url');
  });

  it('rejects a malformed ARTEL_API_BASE_URL the same way', () => {
    const failure = (() => {
      try {
        resolveApiBaseUrl({ ARTEL_API_BASE_URL: 'not-a-url' });
        return null;
      } catch (error) {
        return error as CliError;
      }
    })();

    expect(failure?.code).toBe('invalid_base_url');
    expect(failure?.message).toContain('ARTEL_API_BASE_URL');
  });
});

describe('resolveConsoleBaseUrl', () => {
  it('lets --console-url win over ARTEL_CONSOLE_BASE_URL', () => {
    const url = resolveConsoleBaseUrl(
      { ARTEL_CONSOLE_BASE_URL: 'https://env-console.example.test' },
      undefined,
      'https://flag-console.example.test',
    );
    expect(url).toBe('https://flag-console.example.test');
  });

  it('takes the flag alone when there is no environment variable', () => {
    const url = resolveConsoleBaseUrl({}, undefined, 'https://flag-console.example.test');
    expect(url).toBe('https://flag-console.example.test');
  });

  it('normalizes a trailing slash on the flag value', () => {
    expect(resolveConsoleBaseUrl({}, undefined, 'https://flag-console.example.test/')).toBe(
      'https://flag-console.example.test',
    );
  });

  it('still refuses a loopback API with no console when the API came from --api-url', () => {
    // `resolveConfig` 는 --api-url 로 얻은 값도 그대로 loopback pairing 검사에 넘긴다 —
    // 값의 출처가 flag 든 환경 변수든 이 함수는 그 값 자체만 본다.
    const failure = (() => {
      try {
        resolveConfig({}, { apiBaseUrl: 'http://localhost:8080' });
        return null;
      } catch (error) {
        return error as CliError;
      }
    })();

    expect(failure?.code).toBe('missing_console_base_url');
  });

  it('accepts the loopback API when --console-url pairs it explicitly', () => {
    const config = resolveConfig(
      {},
      { apiBaseUrl: 'http://localhost:8080', consoleBaseUrl: 'http://localhost:5173' },
    );
    expect(config).toEqual({
      apiBaseUrl: 'http://localhost:8080',
      consoleBaseUrl: 'http://localhost:5173',
    });
  });

  it('rejects a malformed --console-url', () => {
    const failure = (() => {
      try {
        resolveConsoleBaseUrl({}, undefined, 'not-a-url');
        return null;
      } catch (error) {
        return error as CliError;
      }
    })();

    expect(failure?.code).toBe('invalid_base_url');
    expect(failure?.message).toContain('--console-url');
  });
});

describe('resolveConfig', () => {
  it('lets both flags win over both environment variables at once', () => {
    const config = resolveConfig(
      {
        ARTEL_API_BASE_URL: 'https://env-api.example.test',
        ARTEL_CONSOLE_BASE_URL: 'https://env-console.example.test',
      },
      {
        apiBaseUrl: 'https://flag-api.example.test',
        consoleBaseUrl: 'https://flag-console.example.test',
      },
    );

    expect(config).toEqual({
      apiBaseUrl: 'https://flag-api.example.test',
      consoleBaseUrl: 'https://flag-console.example.test',
    });
  });

  it('falls back to the environment variables when no overrides are given', () => {
    const config = resolveConfig({
      ARTEL_API_BASE_URL: 'https://env-api.example.test',
      ARTEL_CONSOLE_BASE_URL: 'https://env-console.example.test',
    });

    expect(config).toEqual({
      apiBaseUrl: 'https://env-api.example.test',
      consoleBaseUrl: 'https://env-console.example.test',
    });
  });
});

describe('effectiveApiBaseUrl', () => {
  it('names the environment variable as the source', () => {
    expect(
      effectiveApiBaseUrl({ ARTEL_API_BASE_URL: 'https://env.example.test/' }, null),
    ).toEqual({ value: 'https://env.example.test', source: 'env' });
  });

  it('names the credentials file as the source', () => {
    expect(effectiveApiBaseUrl({}, 'https://stored.example.test/')).toEqual({
      value: 'https://stored.example.test',
      source: 'file',
    });
  });

  /**
   * 값이 URL 로 말이 되는지는 보지 않는다. `auth status` 가 이것을 부르고, 보고하는 명령이
   * 값이 이상하다는 이유로 죽으면 안 된다.
   */
  it('reports a malformed value rather than throwing', () => {
    expect(effectiveApiBaseUrl({ ARTEL_API_BASE_URL: 'not-a-url' }, null)).toEqual({
      value: 'not-a-url',
      source: 'env',
    });
  });

  it('has no source when nothing supplies an address', () => {
    expect(effectiveApiBaseUrl({}, null)).toEqual({ value: null, source: null });
  });
});
