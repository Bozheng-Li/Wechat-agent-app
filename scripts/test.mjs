import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Shared business regressions. Host integration is replaced by app-* and desktop smoke tests.
// Resource/privacy gates now use isolated fixtures and run here too. Legacy host-only
// suites with obsolete harness fixtures stay explicitly inventoried by the coverage guard.
const business = [
  'automatic-memory-compaction', 'authorization-backups', 'chat-image-generation', 'contact-classification', 'conversation-preferences', 'data-root',
  'execution-traces', 'execution-traces-graph', 'execution-traces-skip', 'group-member-authorization', 'image-memory', 'image-reply-grounding',
  'inbound-files', 'inbound-images', 'media-library', 'media-channel-integration', 'memory-retention',
  'memory-scan-performance', 'moments-arrangement', 'moments-automation', 'moments-default-audience', 'moments-friend-replies',
  'moments-image-stream', 'moments-interaction-automation', 'moments-interactions', 'moments-likes',
  'moments-materials', 'moments-person-memory', 'moments-publication-recovery', 'moments-publish-scope', 'moments-publishing',
  'moments-read-authorization', 'moments-recency', 'moments-subject', 'moments-tools', 'natural-chat',
  'object-authorization', 'outbound-media', 'owner-cleanup', 'person-role-cards', 'persona-chat', 'persona-input', 'persona-library', 'persona-pass', 'persona-skill', 'public-language',
  'quiet-replies', 'received-files', 'release-version', 'reply-context', 'reply-context-budget', 'reply-splitting', 'reply-style', 'role-card-groups',
  'manual-reply-context', 'persona-chat-split-ui', 'role-card-version-history', 'role-memory-retrieval-source', 'split-delivery-history', 'understanding-contract',
  'context-evidence-order', 'persona-pass-context', 'persona-privacy', 'package-resources', 'package-artifacts',
  'progressive-prompt', 'progressive-dialogue', 'progressive-tools',
  'role-memory-authorization', 'role-memory-practical', 'role-memory-production', 'schedule-countdown',
  'scheduled-features', 'search-fallback', 'sticker-library', 'sticker-service', 'sticker-tools', 'storage-recovery', 'storage-v2', 'style-distill', 'style-summary',
  'task-history', 'task-mentions', 'test-runner-coverage', 'time-settings', 'web-search', 'worker-send-account', 'worker-transfer-wait', 'workspace-root', 'yaml-configuration',
];
const files = [...fs.readdirSync(path.join(root, 'tests')).filter(name => /^app-.*\.test\.mjs$/.test(name)), ...business.map(name => name + '.test.mjs')];
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files.map(name => path.join(root, 'tests', name))], { cwd: root, windowsHide: true, stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal || code === null ? 1 : code; });
