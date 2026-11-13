import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicBytes } from '../storage/atomic-text.mjs';
import { ChannelError } from '../../shared/contracts.mjs';

/** Ciphertext only. Production uses Electron safeStorage (Windows DPAPI). */
export class CredentialStore {
  constructor(root, encryption) { this.root = path.join(root, 'credentials'); this.encryption = encryption; }
  file(reference) {
    if (typeof reference !== 'string' || !reference || reference.length > 512) throw new ChannelError('CREDENTIAL_INVALID', '密钥名称无效');
    return path.join(this.root, createHash('sha256').update(reference).digest('hex') + '.bin');
  }
  async describe(reference) { return { configured: fs.existsSync(this.file(reference)) }; }
  async set(reference, value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u0020\u007f]/u.test(value.trim()))
      throw new ChannelError('CREDENTIAL_INVALID', '请输入有效的 API Key');
    if (!this.encryption?.isAvailable()) throw new ChannelError('CREDENTIAL_UNAVAILABLE', '系统密钥加密服务不可用，密钥未保存');
    const encrypted = this.encryption.encrypt(value.trim());
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    atomicBytes(this.file(reference), encrypted);
  }
  async delete(reference) {
    const file = this.file(reference);
    try { fs.rmSync(file, { force: true }); return true; } catch { return false; }
  }
  async resolve(reference) {
    const file = this.file(reference);
    if (!fs.existsSync(file)) return undefined;
    if (!this.encryption?.isAvailable()) throw new ChannelError('CREDENTIAL_UNAVAILABLE', '系统密钥加密服务不可用');
    try { return { value: this.encryption.decrypt(fs.readFileSync(file)) }; }
    catch { throw new ChannelError('CREDENTIAL_READ_FAILED', '无法解密此密钥，请在当前 Windows 账号中重新保存'); }
  }
}
