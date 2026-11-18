import { randomBytes } from 'node:crypto';
import { ChannelError, validatePersonaProvenance } from '../../shared/contracts.mjs';
import { conversationAuthorized, personAuthorized, authorizationEpoch, assertAuthorizationEpoch } from '../../shared/authorization.mjs';
import { styleProfile, describeStyle } from './style-profile.mjs';
import { styleSampleEvidence, assistantTask, statisticalStyleFallback, assertStylePrivacy } from './style-summary.mjs';

const MAX_PEERS = 60;
const MAX_ROWS = 1200;
const MIN_SAMPLES = 20;
const DRAFT_TTL_MS = 15 * 60_000;
const MAX_DRAFTS = 32;
const draftsByStore = new WeakMap();
const at = row => Number(row?.time ?? row?.updatedAt ?? row?.lastMessageAt) || 0;
const personAllowed = (store, accountId, senderId) =>
  !store.data.groupMemberExclusions?.[accountId]?.excludedPersonIds?.includes(senderId) && personAuthorized(store, accountId, senderId);

function authorizedPeers(store, accountId) {
  const all = store.conversations(accountId).filter(peer => peer.accountId === accountId && conversationAuthorized(store, peer))
    .sort((a, b) => at(b) - at(a));
  return { peers: all.slice(0, MAX_PEERS), omittedPeers: Math.max(0, all.length - MAX_PEERS) };
}

/** Candidates require a current person grant even when the containing group is granted. */
export function distillCandidates({ store, memory, accountId }) {
  const people = new Map(), { peers, omittedPeers } = authorizedPeers(store, accountId);
  for (const peer of peers) {
    let entries;
    try { entries = memory.view(peer).entries ?? []; } catch { continue; }
    for (const entry of [...entries].sort((a, b) => at(b) - at(a)).slice(0, MAX_ROWS)) {
      if (entry.direction !== 'incoming' || !personAllowed(store, accountId, entry.senderId)) continue;
      const person = people.get(entry.senderId)
        ?? { senderId: entry.senderId, name: entry.senderName || entry.senderId, count: 0, chats: [], omittedPeers };
      person.count += 1;
      const chat = person.chats.find(row => row.peerId === peer.peerId && row.chatType === peer.chatType);
      if (chat) chat.count += 1;
      else person.chats.push({ chatType: peer.chatType, peerId: peer.peerId, name: peer.name || peer.peerId, count: 1 });
      people.set(entry.senderId, person);
    }
  }
  return [...people.values()].filter(row => row.count >= MIN_SAMPLES)
    .sort((a, b) => b.count - a.count);
}

/** Source authority is rechecked at generation, save and every global persona read. */
export function assertDistillSources(store, provenance, { epoch = false } = {}) {
  const source = validatePersonaProvenance(provenance);
  if (epoch) assertAuthorizationEpoch(store, source.accountId, source.epoch);
  if (!personAllowed(store, source.accountId, source.personId) || source.sourceScopes.some(scope => !conversationAuthorized(store, scope)))
    throw new ChannelError('PERSONA_SOURCE_REVOKED', '提炼来源已撤销授权，旧草稿不能保存或使用，请重新生成。');
  return source;
}

export function issuePersonaDraft(store, provenance, now = Date.now(), { entities = [] } = {}) {
  const source = assertDistillSources(store, provenance, { epoch: true });
  let drafts = draftsByStore.get(store);
  if (!drafts) { drafts = new Map(); draftsByStore.set(store, drafts); }
  for (const [token, draft] of drafts) if (draft.expiresAt <= now) drafts.delete(token);
  while (drafts.size >= MAX_DRAFTS) drafts.delete(drafts.keys().next().value);
  const draftToken = randomBytes(32).toString('base64url'), expiresAt = now + DRAFT_TTL_MS;
  drafts.set(draftToken, { provenance: source, expiresAt,
    entities: entities.filter(value => typeof value === 'string' && value.length >= 2 && value.length <= 150).slice(0, 160) });
  return { draftToken, draftExpiresAt: expiresAt };
}

/** A token is unforgeable, memory-only, and consumed only after a successful synchronous write. */
export function savePersonaDraft(store, payload, save, now = Date.now()) {
  const drafts = draftsByStore.get(store), draft = drafts?.get(payload.draftToken);
  if (!draft || draft.expiresAt <= now)
    throw new ChannelError('PERSONA_DRAFT_EXPIRED', '提炼草稿已过期、已保存或服务已重启，请重新生成。');
  if (payload.accountId !== draft.provenance.accountId || payload.senderId !== draft.provenance.personId)
    throw new ChannelError('PERSONA_DRAFT_MISMATCH', '提炼草稿与当前账号或人物不一致，请重新生成。');
  const provenance = assertDistillSources(store, draft.provenance, { epoch: true });
  assertStylePrivacy(payload.persona, { phrases: provenance.phrases, entities: draft.entities });
  const result = save(provenance);
  drafts.delete(payload.draftToken);
  return result;
}

/** Measure the latest bounded messages; raw rows never leave this function. */
export function distillPersona({ store, memory, accountId, senderId, name, title, warmth = 'balanced' }) {
  if (typeof senderId !== 'string' || !senderId)
    throw new ChannelError('PERSONA_SAMPLE_MISSING', '请选择要学习的人');
  if (!personAllowed(store, accountId, senderId))
    throw new ChannelError('PERSONA_SOURCE_REVOKED', '这位人物未授权或已撤销授权，不能提炼。');
  if (!['balanced', 'terse', 'warm'].includes(warmth)) throw new ChannelError('INVALID_PERSONA', '请选择有效的松紧档位');
  const rows = [], { peers, omittedPeers } = authorizedPeers(store, accountId);
  const current = store.persona(), exclude = [current?.name, ...(current?.aliases ?? [])];
  for (const peer of peers) {
    let entries;
    try { entries = memory.view(peer).entries ?? []; } catch { continue; }
    for (const entry of entries) {
      if (entry.direction !== 'incoming' || entry.senderId !== senderId) continue;
      if (assistantTask(String(entry.text ?? '').trim(), exclude)) continue;
      rows.push({ direction: 'incoming', text: entry.text, time: entry.time, mediaOnly: entry.mediaOnly,
        senderName: entry.senderName, chatType: peer.chatType,
        scope: { accountId, chatType: peer.chatType, peerId: peer.peerId } });
    }
  }
  rows.sort((a, b) => at(b) - at(a));
  const latest = rows.slice(0, MAX_ROWS), profile = styleProfile(latest);
  if (profile.messages < MIN_SAMPLES)
    throw new ChannelError('PERSONA_SAMPLE_SMALL', `可用发言只有 ${profile.messages} 条，先多聊一些再提炼`);
  const privacyEntities = [...new Set([senderId, ...latest.map(row => row.senderName), ...peers.flatMap(peer => [peer.name, peer.peerId])])]
    .filter(value => typeof value === 'string' && value.length >= 2 && value.length <= 150).slice(0, 160);
  const { samples, sampling } = styleSampleEvidence(latest, { exclude, entities: privacyEntities });
  sampling.omitted += Math.max(0, rows.length - latest.length);
  sampling.total = rows.length; sampling.omittedPeers = omittedPeers;
  const scopes = [...new Map(latest.map(row => [JSON.stringify(row.scope), row.scope])).values()];
  const provenance = validatePersonaProvenance({ version: 1, accountId, personId: senderId, sourceScopes: scopes,
    epoch: authorizationEpoch(store, accountId), generatedAt: Date.now(),
    phrases: [...new Set(samples.flatMap(row => row.phrases))].slice(0, 80) });
  const assistant = name || current?.name || '微信助手', target = latest.find(row => row.senderName)?.senderName || senderId;
  return {
    accountId, senderId, target, profile, warmth, summary: describeStyle(profile), samples, sampling, provenance, privacyEntities,
    suggestedName: title || (assistant + '·' + (target || '某人') + ' 的说话方式'),
    persona: { name: assistant, aliases: [], prompt: statisticalStyleFallback(profile), personaMode: 'standard' },
  };
}
