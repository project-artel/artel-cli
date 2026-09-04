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
    fullscreen: false,
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
      '-logFile',
      '/home/user/.artel/logs/game-1.log',
      '-screen-width',
      '1280',
      '-screen-height',
      '720',
      '-screen-fullscreen',
      '0',
      '-artel-project',
      '42',
    ]);
    expect(args).not.toContain('-artel-logout');
  });

  it('adds -artel-logout only when asked', () => {
    const args = buildGameLaunchArgs({ ...base, logout: true });
    expect(args.at(-1)).toBe('-artel-logout');
  });

  it('leaves -artel-project out when there is none', () => {
    // 지우러 가는 실행에 프로젝트를 실으면 SDK 가 지운 자리에 그것을 도로 심는다.
    const args = buildGameLaunchArgs({ ...base, projectId: null, logout: true });
    expect(args).not.toContain('-artel-project');
    expect(args).toContain('-artel-logout');
  });

  it('asks for a window by default, so several games can sit side by side', () => {
    // Unity 는 `-screen-fullscreen` 이 없으면 저장된 모드로 뜬다. 그래서 이 인자가 빠지면
    // `-screen-width`/`-screen-height` 를 줘도 전체 화면으로 떠서 크기가 무시된 것처럼 보인다.
    const args = buildGameLaunchArgs({ ...base, logout: false });
    const index = args.indexOf('-screen-fullscreen');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(args[index + 1]).toBe('0');
  });

  it('asks for full screen only when --fullscreen said so', () => {
    const args = buildGameLaunchArgs({ ...base, fullscreen: true, logout: false });
    const index = args.indexOf('-screen-fullscreen');
    expect(args[index + 1]).toBe('1');
  });

  it('renders -artel-secure as the string "true" for an https server', () => {
    const args = buildGameLaunchArgs({ ...base, secure: true, logout: false });
    const index = args.indexOf('-artel-secure');
    expect(args[index + 1]).toBe('true');
  });
});
