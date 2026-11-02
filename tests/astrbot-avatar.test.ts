import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { syncQQAvatar } from '../core/astrbot/avatar.ts';
it('updates the bound avatar while rejecting another Bot and corrupted revisions', () => {
  const root = mkdtempSync(join(tmpdir(),'avatar-'));
  const first = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNUWDWNgYGBiYGBgYGBAQAQNAFk96pZewAAAABJRU5ErkJggg==','base64');
  const value = { source:'qq',bot_id:'bound',mime:'image/png',base64:first.toString('base64'),revision:createHash('sha256').update(first).digest('hex').slice(0,20) };
  try {
    expect(syncQQAvatar(root,value,'bound')).toBe(value.revision);
    expect(readFileSync(join(root,'avatar.png'))).toEqual(first);
    expect(syncQQAvatar(root,{...value,bot_id:'another'},'bound')).toBe(null);
    expect(syncQQAvatar(root,{...value,revision:'wrong'},'bound')).toBe(null);
    expect(readFileSync(join(root,'avatar.png'))).toEqual(first);
  } finally {rmSync(root,{recursive:true,force:true});}
});
