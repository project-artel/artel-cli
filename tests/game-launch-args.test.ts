import { describe, expect, it } from 'vitest';

import { buildGameLaunchArgs, deriveGameServerAddress } from '../src/game/launch-args.js';

describe('deriveGameServerAddress', () => {
  it('keeps an explicit port', () => {
    expect(deriveGameServerAddress('http://localhost:8080')).toEqual({
      serverAddress: 'localhost:8080',
      secure: false,
    });
  });

  it('fills in 443 for https with no explicit port', () => {
    expect(deriveGameServerAddress('https://api.artel.kr')).toEqual({
      serverAddress: 'api.artel.kr:443',
      secure: true,
    });
  });

  it('fills in 80 for http with no explicit port', () => {
    expect(deriveGameServerAddress('http://api.artel.kr')).toEqual({
      serverAddress: 'api.artel.kr:80',
      secure: false,
    });
  });
});

describe('buildGameLaunchArgs', () => {
  const base = {
    serverAddress: 'localhost:8080',
    secure: false,
    frontendUrl: 'https://artel.kr',
    projectId: '42',
    logFilePath: '/home/user/.artel/logs/game-1.log',
    width: 1280,
    height: 720,
  };

  it('never includes -batchmode', () => {
    const args = buildGameLaunchArgs({ ...base, logout: false });
    expect(args).not.toContain('-batchmode');
  });

  it('carries every ARTEL-787 launch argument, and no token', () => {
    const args = buildGameLaunchArgs({ ...base, logout: false });
    expect(args).toEqual([
      '-artel-server',
      'localhost:8080',
      '-artel-secure',
      'false',
      '-artel-frontend',
      'https://artel.kr',
      '-artel-project',
      '42',
      '-logFile',
      '/home/user/.artel/logs/game-1.log',
      '-screen-width',
      '1280',
      '-screen-height',
      '720',
    ]);
    expect(args).not.toContain('-artel-logout');
  });

  it('adds -artel-logout only when asked', () => {
    const args = buildGameLaunchArgs({ ...base, logout: true });
    expect(args.at(-1)).toBe('-artel-logout');
  });

  it('renders -artel-secure as the string "true" for an https server', () => {
    const args = buildGameLaunchArgs({ ...base, secure: true, logout: false });
    const index = args.indexOf('-artel-secure');
    expect(args[index + 1]).toBe('true');
  });
});
