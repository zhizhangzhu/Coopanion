/** Apply only the verified Bot's PNG snapshot to the original avatar endpoint. */
import { createHash } from 'node:crypto';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export function syncQQAvatar(root: string, value: unknown, botId: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const avatar = value as Record<string, unknown>;
  if (avatar.source !== 'qq' || avatar.bot_id !== botId || avatar.mime !== 'image/png' || typeof avatar.base64 !== 'string' || avatar.base64.length > 700000) return null;
  const raw = Buffer.from(avatar.base64, 'base64');
  const revision = createHash('sha256').update(raw).digest('hex').slice(0, 20);
  if (!raw.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || revision !== avatar.revision || raw.length > 512 * 1024) return null;
  const temporary = join(root, 'avatar.qq.tmp');
  writeFileSync(temporary, raw, { mode: 0o600 }); renameSync(temporary, join(root, 'avatar.png'));
  return revision;
}
