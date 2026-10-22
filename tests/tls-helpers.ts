import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface TestCertificate {
  certFile: string;
  keyFile: string;
  cert: string;
}

function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 인증서를 만들 수 있는 기계인가. 없으면 TLS 테스트는 건너뛴다. */
export const canMakeCertificates = opensslAvailable();

/** `127.0.0.1` 에 대한 자체 서명 인증서와 P-256 key. 파일 둘이 작아서 tmpfs 를 거의 쓰지 않는다. */
export async function makeCertificate(dir: string, name: string): Promise<TestCertificate> {
  await fs.mkdir(dir, { recursive: true });
  const certFile = path.join(dir, `${name}.crt`);
  const keyFile = path.join(dir, `${name}.key`);
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '2',
      '-subj',
      `/CN=${name}`,
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  return { certFile, keyFile, cert: await fs.readFile(certFile, 'utf8') };
}
