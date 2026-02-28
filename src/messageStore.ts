import { proto } from '@whiskeysockets/baileys';

interface PendingMessage {
  message: proto.IWebMessageInfo;
  timer: NodeJS.Timeout;
  timestamp: number;
  from: string;
}

export class MessageStore {
  private messages = new Map<string, PendingMessage>();
  private pendingByJid = new Set<string>();

  hasPendingFrom(jid: string): boolean {
    return this.pendingByJid.has(jid);
  }

  add(messageId: string, message: proto.IWebMessageInfo, from: string, timeoutMs: number, onTimeout: () => void): void {
    const timer = setTimeout(() => {
      if (this.messages.has(messageId)) {
        onTimeout();
        this.remove(messageId);
      }
    }, timeoutMs);

    this.messages.set(messageId, { message, timer, timestamp: Date.now(), from });
    this.pendingByJid.add(from);
  }

  remove(messageId: string): void {
    const pending = this.messages.get(messageId);
    if (pending) {
      clearTimeout(pending.timer);
      this.messages.delete(messageId);
      this.pendingByJid.delete(pending.from);
    }
  }

  get(messageId: string): PendingMessage | undefined {
    return this.messages.get(messageId);
  }

  cleanup(): void {
    this.messages.forEach((pending) => clearTimeout(pending.timer));
    this.messages.clear();
    this.pendingByJid.clear();
  }
}
