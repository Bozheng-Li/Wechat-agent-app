import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Shared business regressions. Host integration is replaced by app-* and desktop smoke tests.
const business = [
  'automatic-memory-compaction', 'authorization-backups', 'contact-classification', 'conversation-preferences',
  'execution-traces', 'execution-traces-graph', 'generated-image-memory', 'image-memory', 'image-reply-grounding',
  'inbound-files', 'inbound-images', 'media-library', 'media-channel-integration', 'memory-retention',
  'memory-scan-performance', 'moments-arrangement', 'moments-automation', 'moments-friend-replies',
  'moments-image-stream', 'moments-interaction-automation', 'moments-interactions', 'moments-likes',
  'moments-materials', 'moments-person-memory', 'moments-publication-recovery', 'moments-publishing',
  'moments-read-authorization', 'moments-recency', 'moments-subject', 'moments-tools', 'natural-chat',
  'object-authorization', 'outbound-media', 'owner-cleanup', 'person-role-cards', 'persona-input',
  'quiet-replies', 'received-files', 'reply-context', 'reply-context-budget', 'reply-style', 'role-card-groups',
  'role-memory-authorization', 'role-memory-practical', 'role-memory-production', 'schedule-countdown',
  'scheduled-features', 'sticker-library', 'sticker-service', 'sticker-tools', 'storage-v2',
  'task-history', 'task-mentions', 'time-settings', 'worker-send-account', 'worker-transfer-wait', 'yaml-configuration',
];
const files = [...fs.readdirSync(path.join(root, 'tests')).filter(name => /^app-.*\.test\.mjs$/.test(name)), ...business.map(name => name + '.test.mjs')];
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files.map(name => path.join(root, 'tests', name))], { cwd: root, windowsHide: true, stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal || code === null ? 1 : code; });
