import { UsageError } from '../errors.js';

/**
 * `--folder <id>`(또는 `--parent <id>`) 와 `--root` 중 어느 쪽을 줬는지 읽는다.
 *
 * `null` 은 "folder 없음(최상위)" 이고 `undefined` 는 "아무것도 주지 않음" 이다. 둘을 같은
 * 값으로 다루면 안 된다: 서버는 `folderId` 나 `parentId` 가 비어 있으면 최상위로 옮기므로,
 * 지정하지 않은 것을 `null` 로 보내면 사용자가 바라지 않은 이동이 일어난다.
 */
export function readFolderTarget(
  folderId: string | undefined,
  root: boolean,
  flagLabel: string,
): string | null | undefined {
  if (folderId !== undefined && root) {
    throw new UsageError(`Pass either ${flagLabel} or --root, not both.`);
  }
  if (root) {
    return null;
  }
  if (folderId !== undefined && folderId.trim().length === 0) {
    throw new UsageError(`${flagLabel} needs a folder id; use --root for no folder.`);
  }
  return folderId;
}
