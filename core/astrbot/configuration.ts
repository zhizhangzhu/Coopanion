/** Declared World configuration validation and private-key storage boundaries. */
import { isDeepStrictEqual } from 'node:util';

export interface PropertySchema {
  type?: string; nullable?: boolean; enum?: unknown[]; const?: unknown;
  minimum?: number; maximum?: number; multipleOf?: number;
  minLength?: number; maxLength?: number; pattern?: string;
  items?: PropertySchema; prefixItems?: PropertySchema[]; minItems?: number; maxItems?: number; uniqueItems?: boolean;
  properties?: Record<string, PropertySchema>; required?: string[]; additionalProperties?: boolean | PropertySchema;
  oneOf?: PropertySchema[]; anyOf?: PropertySchema[];
}
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export function configPath(world: string, key: string): string[] {
  const prefix = `worlds.${world}.`;
  if (!key.startsWith(prefix)) throw new Error('unknown_config_key');
  const parts = key.slice(prefix.length).split('.');
  if (parts.some((part) => !part || forbidden.has(part))) throw new Error('invalid_config_key');
  return parts;
}
export function validateValue(value: unknown, schema: PropertySchema, depth = 0): void {
  if (depth > 16) throw new Error('config_too_deep');
  if (value === null && schema.nullable) return;
  if (schema.oneOf || schema.anyOf) {
    let matches = 0;
    for (const candidate of schema.oneOf ?? schema.anyOf ?? []) { try { validateValue(value, candidate, depth + 1); matches++; } catch { /* Try the next declared branch. */ } }
    if (schema.oneOf ? matches !== 1 : matches === 0) throw new Error('invalid_config_branch');
  }
  if (schema.enum && !schema.enum.some((item) => isDeepStrictEqual(item, value))) throw new Error('invalid_config_option');
  if ('const' in schema && !isDeepStrictEqual(schema.const, value)) throw new Error('invalid_config_constant');
  switch (schema.type) {
    case 'boolean': if (typeof value !== 'boolean') throw new Error('invalid_boolean'); break;
    case 'integer': if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('invalid_integer'); break;
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('invalid_number'); break;
    case 'string':
      if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 16384)) throw new Error('invalid_string');
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error('invalid_string_pattern');
      break;
    case 'array':
      if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 256)) throw new Error('invalid_array');
      value.forEach((item, index) => validateValue(item, schema.prefixItems?.[index] ?? schema.items ?? {}, depth + 1));
      if (schema.uniqueItems && value.some((item, index) => value.slice(0, index).some((prior) => isDeepStrictEqual(item, prior)))) throw new Error('duplicate_array_item');
      break;
    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_object');
      for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new Error('missing_config_property');
      for (const [key, item] of Object.entries(value)) {
        if (forbidden.has(key)) throw new Error('invalid_config_key');
        const field = schema.properties?.[key];
        if (!field && schema.additionalProperties === false) throw new Error('unknown_config_property');
        validateValue(item, field ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : {}), depth + 1);
      }
      break;
    case undefined:
      if (value && typeof value === 'object') {
        if (Array.isArray(value)) value.forEach((item) => validateValue(item, {}, depth + 1));
        else for (const [key, item] of Object.entries(value)) { if (forbidden.has(key)) throw new Error('invalid_config_key'); validateValue(item, {}, depth + 1); }
      }
      break;
    default: throw new Error('unsupported_config_type');
  }
  if (typeof value === 'number') {
    if ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) throw new Error('config_out_of_range');
    if (schema.multipleOf && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-8) throw new Error('invalid_config_multiple');
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 65536) throw new Error('config_too_large');
}
export function assignPath(target: Record<string, unknown>, parts: string[], value: unknown): void {
  for (const part of parts.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== 'object' || Array.isArray(target[part])) target[part] = {};
    target = target[part] as Record<string, unknown>;
  }
  target[parts.at(-1)!] = structuredClone(value);
}
