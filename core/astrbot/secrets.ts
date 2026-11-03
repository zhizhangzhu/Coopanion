/** Per-device World secrets encrypted with the current Windows user's DPAPI. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
export interface SecretEncryption { seal(value: Buffer): Buffer; open(value: Buffer): Buffer }
export function windowsEncryption(entropy: string): SecretEncryption {
  const transform = (operation: 'seal' | 'open', value: Buffer): Buffer => {
    if (process.platform !== 'win32') throw new Error('windows_secure_storage_required');
    const script = "Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd()|ConvertFrom-Json; $b=[Convert]::FromBase64String($v.data); $e=[Text.Encoding]::UTF8.GetBytes($v.entropy); if($v.op -eq 'seal'){$r=[Security.Cryptography.ProtectedData]::Protect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)}else{$r=[Security.Cryptography.ProtectedData]::Unprotect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)}; [Console]::Out.Write([Convert]::ToBase64String($r))";
    const result = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      input: JSON.stringify({ op: operation, data: value.toString('base64'), entropy }), encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout || result.error) throw new Error('secure_storage_failed');
    return Buffer.from(result.stdout.trim(), 'base64');
  };
  return { seal: (value) => transform('seal', value), open: (value) => transform('open', value) };
}
export class SecretVault {
  private values: Record<string, Record<string, string>>;
  constructor(private path: string, private encryption: SecretEncryption = windowsEncryption(path)) {
    this.values = existsSync(path) ? JSON.parse(encryption.open(readFileSync(path)).toString('utf8')) as Record<string, Record<string, string>> : {};
  }
  get(world: string, name: string): string { return this.values[world]?.[name] ?? ''; }
  names(world: string): string[] { return Object.keys(this.values[world] ?? {}); }
  set(world: string, name: string, value: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || ['__proto__', 'prototype', 'constructor'].includes(world) || /\s/.test(value) || value.length > 4096) throw new Error('invalid_secret');
    const next = structuredClone(this.values);
    next[world] ??= {};
    if (value) next[world][name] = value; else delete next[world][name];
    const encrypted = this.encryption.seal(Buffer.from(JSON.stringify(next)));
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path + '.tmp', encrypted, { mode: 0o600 });
    renameSync(this.path + '.tmp', this.path);
    this.values = next;
  }
}
