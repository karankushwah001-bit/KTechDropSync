import * as FileSystem from 'expo-file-system/legacy';
import * as Network from 'expo-network';
import { getWebInterface } from './webInterface';
import { initStorageDirs, listFiles, getMimeType, SHARED_DIR, UPLOADS_DIR, FileInfo } from './storage';

let TcpSocket: any = null;
try {
  const mod = require('react-native-tcp-socket');
  TcpSocket = mod.default || mod;
} catch {
  // Expo Go Fallback Mode
}

export const SERVER_PORT = 5050;

export interface TextEntry {
  id: string;
  text: string;
  source: 'phone' | 'browser';
  timestamp: number;
}

export interface ActivityItem {
  id: string;
  type: 'upload' | 'download' | 'text';
  filename?: string;
  size?: number;
  text?: string;
  timestamp: number;
}

interface ParsedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}

interface ConnectionState {
  chunks: Buffer[];
  totalLength: number;
  headerEnd: number;
  contentLength: number;
}

let serverInstance: any = null;
let isServerRunning = false;
const textsStorage: TextEntry[] = [];
const activityLog: ActivityItem[] = [];
let onUpdateCallback: (() => void) | null = null;

export async function initDirs(): Promise<void> {
  await initStorageDirs();
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function bufferIndexOf(haystack: Buffer, needle: Buffer, fromIndex = 0): number {
  outer: for (let i = fromIndex; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function buildResponse(
  status: number, statusText: string, contentType: string,
  body: string | Buffer, extra: string[] = []
): Buffer {
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const headers = [
    `HTTP/1.1 ${status} ${statusText}`,
    `Content-Type: ${contentType}`,
    `Content-Length: ${bodyBuf.length}`,
    'Access-Control-Allow-Origin: *',
    'Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers: Content-Type, Accept',
    'Connection: close',
    ...extra,
    '', '',
  ].join('\r\n');
  return Buffer.concat([Buffer.from(headers, 'utf8'), bodyBuf]);
}

function parseRequest(buf: Buffer): ParsedRequest | null {
  const headerEndBuf = Buffer.from('\r\n\r\n');
  const headerEnd = bufferIndexOf(buf, headerEndBuf, 0);
  if (headerEnd === -1) return null;
  const headerStr = buf.slice(0, headerEnd).toString('utf8');
  const lines = headerStr.split('\r\n');
  if (!lines[0]) return null;
  const [method, rawPath] = lines[0].split(' ');
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].indexOf(':');
    if (c > -1) headers[lines[i].slice(0, c).trim().toLowerCase()] = lines[i].slice(c + 1).trim();
  }
  return { method: method ?? 'GET', path: rawPath ?? '/', headers, body: buf.slice(headerEnd + 4) };
}

function parseMultipart(body: Buffer, rawBoundary: string) {
  const boundary = rawBoundary.replace(/^"|"$/g, '');
  const files: { fieldName: string; filename: string; contentType: string; data: Buffer }[] = [];
  const boundaryBuf = Buffer.from('--' + boundary);
  const crlfBoundaryBuf = Buffer.from('\r\n--' + boundary);
  const headerEndBuf = Buffer.from('\r\n\r\n');
  let pos = bufferIndexOf(body, boundaryBuf, 0);
  if (pos === -1) return files;
  pos += boundaryBuf.length;
  while (pos < body.length) {
    if (pos + 1 < body.length && body[pos] === 0x0d && body[pos + 1] === 0x0a) {
      pos += 2;
    } else break;
    const headerEnd = bufferIndexOf(body, headerEndBuf, pos);
    if (headerEnd === -1) break;
    const headerStr = body.slice(pos, headerEnd).toString('utf8');
    pos = headerEnd + 4;
    const nextBoundary = bufferIndexOf(body, crlfBoundaryBuf, pos);
    if (nextBoundary === -1) break;
    const data = body.slice(pos, nextBoundary);
    pos = nextBoundary + crlfBoundaryBuf.length;
    const dispMatch = headerStr.match(/content-disposition:\s*form-data;[^\r\n]*name="([^"]+)"(?:;\s*filename="([^"]+)")?/i);
    if (dispMatch?.[2]) {
      const ctMatch = headerStr.match(/content-type:\s*([^\r\n]+)/i);
      files.push({
        fieldName: dispMatch[1],
        filename: dispMatch[2],
        contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
        data,
      });
    }
    if (pos + 2 <= body.length && body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
  }
  return files;
}

async function handleRequest(req: ParsedRequest, socket: any) {
  const { method } = req;
  const [rawPath] = req.path.split('?');
  const path = decodeURIComponent(rawPath);

  if (method === 'OPTIONS') {
    socket.write(buildResponse(200, 'OK', 'text/plain', ''));
    try { socket.destroy(); } catch {} return;
  }

  if (path === '/' && method === 'GET') {
    socket.write(buildResponse(200, 'OK', 'text/html; charset=utf-8', getWebInterface()));
    try { socket.destroy(); } catch {} return;
  }

  if (path === '/api/status' && method === 'GET') {
    socket.write(buildResponse(200, 'OK', 'application/json', JSON.stringify({ status: 'running', version: '3.0 Elite Edition' })));
    try { socket.destroy(); } catch {} return;
  }

  if (path === '/api/files/shared' && method === 'GET') {
    const files = await listFiles(SHARED_DIR);
    socket.write(buildResponse(200, 'OK', 'application/json', JSON.stringify({ files })));
    try { socket.destroy(); } catch {} return;
  }

  if (path === '/api/files/uploaded' && method === 'GET') {
    const files = await listFiles(UPLOADS_DIR);
    socket.write(buildResponse(200, 'OK', 'application/json', JSON.stringify({ files })));
    try { socket.destroy(); } catch {} return;
  }

  if (path.startsWith('/api/download/') && method === 'GET') {
    const parts = path.split('/');
    const type = parts[3];
    const filename = parts.slice(4).join('/');
    const dir = type === 'shared' ? SHARED_DIR : UPLOADS_DIR;
    const fileUri = dir + filename;
    try {
      const info = await FileSystem.getInfoAsync(fileUri);
      if (!info.exists || info.isDirectory) {
        socket.write(buildResponse(404, 'Not Found', 'text/plain', 'File not found'));
        try { socket.destroy(); } catch {} return;
      }
      const totalSize = (info as any).size ?? 0;
      const headers = [
        'HTTP/1.1 200 OK',
        `Content-Type: ${getMimeType(filename)}`,
        `Content-Length: ${totalSize}`,
        'Access-Control-Allow-Origin: *',
        `Content-Disposition: attachment; filename="${filename}"`,
        'Connection: close',
        '', '',
      ].join('\r\n');
      socket.write(Buffer.from(headers, 'utf8'));

      const CHUNK = 512 * 1024;
      let position = 0;
      while (position < totalSize) {
        const length = Math.min(CHUNK, totalSize - position);
        const base64Chunk = await FileSystem.readAsStringAsync(fileUri, {
          encoding: FileSystem.EncodingType.Base64,
          position,
          length,
        });
        socket.write(Buffer.from(base64Chunk, 'base64'));
        position += length;
      }

      activityLog.unshift({ id: uid(), type: 'download', filename, size: totalSize, timestamp: Date.now() });
      if (activityLog.length > 50) activityLog.pop();
      onUpdateCallback?.();
    } catch {
      try { socket.write(buildResponse(500, 'Error', 'text/plain', 'Failed to read file')); } catch {}
    }
    try { socket.destroy(); } catch {} return;
  }

  if (path === '/api/upload' && method === 'POST') {
    const ct = req.headers['content-type'] ?? '';
    const bm = ct.match(/boundary=([^\s;]+)/);
    if (!bm) {
      socket.write(buildResponse(400, 'Bad Request', 'text/plain', 'Missing boundary'));
      try { socket.destroy(); } catch {} return;
    }
    const parts = parseMultipart(req.body, bm[1]);
    const uploaded: string[] = [];
    for (const part of parts) {
      if (part.filename && part.data.length > 0) {
        const safeName = part.filename.replace(/[/\\]/g, '_');
        await FileSystem.writeAsStringAsync(UPLOADS_DIR + safeName, part.data.toString('base64'), { encoding: FileSystem.EncodingType.Base64 });
        uploaded.push(safeName);
        activityLog.unshift({ id: uid(), type: 'upload', filename: safeName, size: part.data.length, timestamp: Date.now() });
      }
    }
    socket.write(buildResponse(200, 'OK', 'application/json', JSON.stringify({ status: 'success', uploaded })));
    try { socket.destroy(); } catch {}
    onUpdateCallback?.(); return;
  }

  if (path.startsWith('/api/delete/') && method === 'POST') {
    const parts = path.split('/');
    const type = parts[3];
    const filename = parts.slice(4).join('/');
    const dir = type === 'shared' ? SHARED_DIR : UPLOADS_DIR;
    try {
      await FileSystem.deleteAsync(dir + filename, { idempotent: true });
      socket.write(buildResponse(200, 'OK', 'application/json', JSON.stringify({ status: 'deleted' })));
      onUpdateCallback?.();
    } catch {
      socket.write(buildResponse(500, 'Error', 'application/json', JSON.stringify({ status: 'error' })));
    }
    try { socket.destroy(); } catch {} return;
  }

  if (path === '/api/text' && method === 'POST') {
    const bodyStr = req.body.toString('utf8');
    const textMatch = bodyStr.match(/(?:^|&)text=([^&]*)/);
    const rawText = textMatch ? textMatch[1] : bodyStr;
    const text = decodeURIComponent(rawText.replace(/\+/g, ' ')).trim();
    if (text) {
      textsStorage.unshift({ id: uid(), text, source: 'browser', timestamp: Date.now() });
      activityLog.unshift({ id: uid(), type: 'text', text: text.slice(0, 60), timestamp: Date.now() });
      onUpdateCallback?.();
    }
    socket.write(buildResponse(200, 'OK', 'application/json', JSON.stringify({ status: 'received' })));
    try { socket.destroy(); } catch {} return;
  }

  if (path === '/api/texts' && method === 'GET') {
    socket.write(buildResponse(200, 'OK', 'application/json', JSON.stringify({ texts: textsStorage })));
    try { socket.destroy(); } catch {} return;
  }

  socket.write(buildResponse(404, 'Not Found', 'text/plain', 'Not found'));
  try { socket.destroy(); } catch {}
}

/**
 * Advanced Dynamic IP Resolver
 * Detects actual active network IP (Wi-Fi or Hotspot)
 */
export async function resolveLocalIp(): Promise<string> {
  try {
    const ip = await Network.getIpAddressAsync();
    // Valid IPv4 check excluding Loopback, Null, or Broadcast
    if (ip && ip !== '0.0.0.0' && ip !== '127.0.0.1' && !ip.startsWith('169.254')) {
      return ip;
    }
  } catch {}

  // Native Sockets Query Fallback
  if (TcpSocket && typeof TcpSocket.getIpAddress === 'function') {
    try {
      const nativeIp = TcpSocket.getIpAddress();
      if (nativeIp && nativeIp !== '0.0.0.0' && nativeIp !== '127.0.0.1') {
        return nativeIp;
      }
    } catch {}
  }

  // Hotspot AP mode standard gateway fallback
  return '192.168.43.1';
}

export function isTcpAvailable(): boolean { 
  return TcpSocket !== null && typeof TcpSocket.createServer === 'function'; 
}

export async function startServer(port: number, onUpdate: () => void): Promise<string> {
  if (isServerRunning) return await resolveLocalIp();
  await initStorageDirs();
  onUpdateCallback = onUpdate;
  const activeIp = await resolveLocalIp();

  if (!isTcpAvailable()) {
    isServerRunning = true;
    return activeIp;
  }

  return new Promise((resolve, reject) => {
    const connections = new Map<string, ConnectionState>();
    try {
      const server = TcpSocket.createServer((socket: any) => {
        const connId = uid();
        connections.set(connId, { chunks: [], totalLength: 0, headerEnd: -1, contentLength: 0 });
        socket.on('data', (rawData: Buffer | string) => {
          const chunk = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData as string, 'binary');
          const state = connections.get(connId);
          if (!state) return;
          state.chunks.push(chunk);
          state.totalLength += chunk.length;
          const buf = Buffer.concat(state.chunks, state.totalLength);
          if (state.headerEnd === -1) {
            const idx = bufferIndexOf(buf, Buffer.from('\r\n\r\n'), 0);
            if (idx === -1) return;
            state.headerEnd = idx;
            const headerStr = buf.slice(0, idx).toString('utf8');
            const clMatch = headerStr.match(/content-length:\s*(\d+)/i);
            state.contentLength = clMatch ? parseInt(clMatch[1]) : 0;
          }
          const bodyReceived = state.totalLength - (state.headerEnd + 4);
          if (bodyReceived < state.contentLength) return;
          connections.delete(connId);
          const req = parseRequest(buf);
          if (!req) {
            try { socket.write(buildResponse(400, 'Bad Request', 'text/plain', 'Bad Request')); socket.destroy(); } catch {}
            return;
          }
          handleRequest(req, socket).catch(() => {
            try { socket.write(buildResponse(500, 'Error', 'text/plain', 'Server Error')); socket.destroy(); } catch {}
          });
        });
        socket.on('error', () => { connections.delete(connId); try { socket.destroy(); } catch {} });
        socket.on('close', () => connections.delete(connId));
        socket.setTimeout(30000);
        socket.on('timeout', () => { connections.delete(connId); try { socket.destroy(); } catch {} });
      });

      if (!server) {
        isServerRunning = true;
        return resolve(activeIp);
      }

      server.on('error', (err: Error) => { isServerRunning = false; serverInstance = null; reject(err); });
      server.listen({ port, host: '0.0.0.0' }, () => {
        serverInstance = server;
        isServerRunning = true;
        resolve(activeIp);
      });
    } catch (err) {
      isServerRunning = true;
      resolve(activeIp);
    }
  });
}

export function stopServer(): void {
  if (serverInstance) { try { serverInstance.close(); } catch {} serverInstance = null; }
  isServerRunning = false;
  onUpdateCallback = null;
}

export function getIsRunning(): boolean { return isServerRunning; }
export function getTexts(): TextEntry[] { return [...textsStorage]; }
export function getActivities(): ActivityItem[] { return [...activityLog]; }

export function addPhoneText(text: string): void {
  textsStorage.unshift({ id: uid(), text, source: 'phone', timestamp: Date.now() });
  if (textsStorage.length > 20) textsStorage.pop();
}

export function removeText(id: string): void {
  const idx = textsStorage.findIndex(t => t.id === id);
  if (idx > -1) textsStorage.splice(idx, 1);
}

export function clearActivities(): void { activityLog.length = 0; }

export { SHARED_DIR, UPLOADS_DIR, FileInfo };
