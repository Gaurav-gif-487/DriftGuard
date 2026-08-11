import fs from 'node:fs';
import path from 'node:path';
import type { Field, FieldType, Schema } from './types.js';

/** Parses a real GraphQL SDL document into the same canonical Schema model used by HTTP parsers. */
export function parseGraphQLType(typeText: string): FieldType {
  let text = typeText.trim();
  if (text.endsWith('!')) text = text.slice(0, -1).trim();
  if (text.startsWith('[') && text.endsWith(']')) return { kind: 'array', element: parseGraphQLType(text.slice(1, -1)) };
  if (['String','ID'].includes(text)) return { kind: 'primitive', name: 'string' };
  if (['Int','Float'].includes(text)) return { kind: 'primitive', name: 'number' };
  if (text === 'Boolean') return { kind: 'primitive', name: 'boolean' };
  return { kind: 'reference', name: text };
}

export function normalizeGraphQLField(typeText: string): Field {
  const nullable = !typeText.trim().endsWith('!');
  // GraphQL object fields are selected as part of the response shape; absence
  // is not the same thing as nullability. `!` controls nullability only.
  return { type: parseGraphQLType(typeText), optional: false, nullable };
}

export function parseGraphQLSchema(source: string, name?: string): Schema {
  const fields: Record<string, Field> = {};
  const typeBlocks = /type\s+([A-Za-z_][A-Za-z0-9_]*)[^\{]*\{([\s\S]*?)\}/g;
  const wanted = name ? new RegExp(`type\\s+${escapeRegExp(name)}\\b[^\\{]*\\{([\\s\\S]*?)\\}`, 'm').exec(source)?.[1] : typeBlocks.exec(source)?.[2];
  if (!wanted) return { kind: 'object', name, fields };
  const body = wanted.replace(/#.*/g, ' ');
  const fieldPattern = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*:\s*(\[*[A-Za-z_][A-Za-z0-9_\[\]!]*)(?=\s|$)/g;
  for (const match of body.matchAll(fieldPattern)) fields[match[1]!] = normalizeGraphQLField(match[2]!);
  return { kind: 'object', name, fields };
}

export function parseGraphQLFile(filePath: string, typeName?: string): Schema {
  return parseGraphQLSchema(fs.readFileSync(filePath, 'utf8'), typeName ?? path.basename(filePath, path.extname(filePath)));
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
