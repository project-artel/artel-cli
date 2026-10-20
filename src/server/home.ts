import fs from 'node:fs/promises';
import path from 'node:path';

/** artel-home 이 build 때 `VITE_ORCHESTRATION_URL` 자리에 넣어 두는 값. */
export const ORCHESTRATION_URL_PLACEHOLDER = '__ARTEL_ORCHESTRATION_URL__';

/** placeholder 를 바꾸는 파일. 그림과 font 는 건드리지 않는다. */
const TEXT_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.json',
  '.map',
  '.txt',
  '.svg',
  '.webmanifest',
  '.xml',
]);

interface HomeStamp {
  runtimeVersion: string;
  url: string;
}

async function readStamp(stampFile: string): Promise<HomeStamp | null> {
  try {
    const raw = JSON.parse(await fs.readFile(stampFile, 'utf8')) as Partial<HomeStamp>;
    if (typeof raw.runtimeVersion === 'string' && typeof raw.url === 'string') {
      return { runtimeVersion: raw.runtimeVersion, url: raw.url };
    }
  } catch {
    // stamp 가 없거나 깨졌으면 새로 만든다.
  }
  return null;
}

async function copyWithReplacement(from: string, to: string, url: string): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyWithReplacement(source, target, url);
    } else if (entry.isFile()) {
      if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const text = await fs.readFile(source, 'utf8');
        await fs.writeFile(target, text.split(ORCHESTRATION_URL_PLACEHOLDER).join(url));
      } else {
        await fs.copyFile(source, target);
      }
    }
  }
}

/**
 * runtime 의 `home/` 을 데이터 디렉터리로 복사하면서 placeholder 를 공개 URL 로 바꾼다.
 * runtime 버전과 URL 이 지난번과 같으면 아무것도 하지 않는다. 다시 만들었으면 `true`.
 *
 * 다 만든 뒤에 옮긴다. 복사 도중 죽어도 반쯤 바뀐 `home/` 이 남지 않는다.
 */
export async function prepareHome(options: {
  runtimeHomeDir: string;
  homeDir: string;
  stampFile: string;
  runtimeVersion: string;
  url: string;
}): Promise<boolean> {
  const stamp = await readStamp(options.stampFile);
  const homeExists = await fs
    .stat(options.homeDir)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  if (homeExists && stamp?.runtimeVersion === options.runtimeVersion && stamp.url === options.url) {
    return false;
  }

  const staging = `${options.homeDir}.staging`;
  await fs.rm(staging, { recursive: true, force: true });
  await copyWithReplacement(options.runtimeHomeDir, staging, options.url);
  await fs.rm(options.homeDir, { recursive: true, force: true });
  await fs.rename(staging, options.homeDir);
  const next: HomeStamp = { runtimeVersion: options.runtimeVersion, url: options.url };
  await fs.writeFile(options.stampFile, `${JSON.stringify(next, null, 2)}\n`);
  return true;
}
