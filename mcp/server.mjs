#!/usr/bin/env node
// Puente MCP local: Claude Code habla por stdio y esto reenvía a la API de Notas.
// La llave sale del .env del proyecto, así no queda escrita en la configuración de Claude.
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split('\n').map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const URL_API = process.env.NOTAS_API_URL || env.NOTAS_API_URL;
const KEY = process.env.NOTAS_API_KEY || env.NOTAS_API_KEY;
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.zip': 'application/zip', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4' };
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

async function handle(msg) {
  const a = msg.params?.arguments;
  if (msg.method === 'tools/call' && msg.params?.name === 'adjuntar_fichero' && a?.ruta) {
    if (statSync(a.ruta).size > 10 * 1024 * 1024) throw new Error('Máximo 10 MB');
    msg.params.arguments = { nota_id: a.nota_id, nombre: basename(a.ruta), tipo: TYPES[extname(a.ruta).toLowerCase()] || 'application/octet-stream', base64: readFileSync(a.ruta).toString('base64') };
  }
  const r = await fetch(URL_API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-notas-key': KEY }, body: JSON.stringify(msg) });
  if (msg.id === undefined) return;
  if (!r.ok && r.status !== 400) throw new Error(`La API respondió ${r.status}`);
  send(await r.json());
}
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch((e) => {
    if (msg.id === undefined) return;
    if (msg.method === 'tools/call') send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: e.message }] } });
    else send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: e.message } });
  });
});
