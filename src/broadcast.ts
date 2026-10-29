import { WASocket, WAMessage, SignalKeyStore, downloadMediaMessage, areJidsSameUser, jidNormalizedUser, isLidUser, isPnUser } from '@whiskeysockets/baileys';
import P from 'pino';

const COMMAND = /^\/bc(?:\s+|$)/i;
const MIN_DELAY_MS = 10_000;
const MAX_DELAY_MS = 30_000;

interface BroadcastContext {
  getSock: () => WASocket;
  keys: SignalKeyStore;
  labelName: string;
  logger: P.Logger;
}

let running = false;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(): number {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

function displayNumber(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

export function isSelfChat(sock: WASocket, jid: string | null | undefined): boolean {
  if (!jid || !sock.user) return false;
  return areJidsSameUser(jid, sock.user.id) || areJidsSameUser(jid, sock.user.lid);
}

// Returns the text after "/bc", or null if the message is not a broadcast command
function commandBody(msg: WAMessage): string | null {
  const m = msg.message;
  const text = m?.conversation || m?.extendedTextMessage?.text || m?.imageMessage?.caption || m?.videoMessage?.caption || '';
  if (!COMMAND.test(text)) return null;
  return text.replace(COMMAND, '').trim();
}

// Labels already synced are not re-sent by WhatsApp, so reset the "regular"
// app state collection (where labels live) and resync it from a full snapshot
async function fetchLabelMembers(ctx: BroadcastContext): Promise<string[] | null> {
  const sock = ctx.getSock();
  const labels = new Map<string, string>();
  const members = new Map<string, Set<string>>();

  const onEdit = (label: { id: string; name: string; deleted: boolean }) => {
    if (label.deleted) labels.delete(label.id);
    else labels.set(label.id, label.name);
  };
  const onAssociation = ({ association, type }: { association: { type: unknown; chatId: string; labelId: string }; type: 'add' | 'remove' }) => {
    if (association.type !== 'label_jid') return;
    const set = members.get(association.labelId) || new Set<string>();
    if (type === 'add') set.add(association.chatId);
    else set.delete(association.chatId);
    members.set(association.labelId, set);
  };

  sock.ev.on('labels.edit', onEdit);
  sock.ev.on('labels.association', onAssociation);
  try {
    await ctx.keys.set({ 'app-state-sync-version': { regular: null } });
    await sock.resyncAppState(['regular'], false);
  } finally {
    sock.ev.off('labels.edit', onEdit);
    sock.ev.off('labels.association', onAssociation);
  }

  const wanted = ctx.labelName.toLowerCase();
  const labelId = [...labels].find(([, name]) => name.toLowerCase() === wanted)?.[0];
  if (!labelId) return null;

  // The same person can be labelled under both their phone JID and their LID
  const recipients = new Map<string, string>();
  for (const chatId of members.get(labelId) || []) {
    if (!isPnUser(chatId) && !isLidUser(chatId)) continue; // skip groups etc.
    let key = jidNormalizedUser(chatId);
    if (isLidUser(chatId)) {
      key = (await sock.signalRepository.lidMapping.getPNForLID(chatId).catch(() => null)) || key;
      key = jidNormalizedUser(key);
    }
    if (!recipients.has(key)) recipients.set(key, chatId);
  }
  return [...recipients.values()];
}

async function buildContent(ctx: BroadcastContext, msg: WAMessage, body: string) {
  const m = msg.message;
  if (m?.imageMessage || m?.videoMessage) {
    const sock = ctx.getSock();
    const media = await downloadMediaMessage(msg, 'buffer', {}, { logger: ctx.logger, reuploadRequest: sock.updateMediaMessage });
    const caption = body || undefined;
    return m.imageMessage ? { image: media, caption } : { video: media, caption };
  }

  // Reuse the link preview the phone already generated for the command message
  const ext = m?.extendedTextMessage;
  if (ext?.matchedText && ext.title) {
    return {
      text: body,
      linkPreview: {
        'canonical-url': ext.matchedText,
        'matched-text': ext.matchedText,
        title: ext.title,
        description: ext.description || undefined,
        jpegThumbnail: ext.jpegThumbnail ? Buffer.from(ext.jpegThumbnail) : undefined
      }
    };
  }
  return { text: body };
}

// Handles "/bc <message>" sent to your own chat ("Message yourself").
// "/bc" alone only lists the recipients. Returns true if the message was a command.
export async function handleBroadcastCommand(ctx: BroadcastContext, msg: WAMessage): Promise<boolean> {
  const body = commandBody(msg);
  if (body === null) return false;

  const selfJid = jidNormalizedUser(ctx.getSock().user!.id);
  const reply = (text: string) => ctx.getSock().sendMessage(selfJid, { text }).catch(err => console.error('✗ Failed to send broadcast report:', err));

  if (running) {
    await reply('⏳ Broadcast sebelumnya masih berjalan. Tunggu sampai selesai.');
    return true;
  }
  running = true;

  try {
    const recipients = await fetchLabelMembers(ctx);
    if (!recipients) {
      await reply(`✗ Label "${ctx.labelName}" tidak ditemukan.`);
      return true;
    }

    const hasMedia = !!(msg.message?.imageMessage || msg.message?.videoMessage);
    if (!body && !hasMedia) {
      const list = recipients.map((jid, i) => `${i + 1}. ${displayNumber(jid)}`).join('\n');
      await reply(`Label "${ctx.labelName}" berisi ${recipients.length} kontak:\n${list}\n\nKirim "/bc isi pesan" untuk broadcast.`);
      return true;
    }

    const content = await buildContent(ctx, msg, body);
    const estimateMins = Math.ceil(recipients.length * (MIN_DELAY_MS + MAX_DELAY_MS) / 2 / 60000);
    await reply(`▶ Mulai broadcast ke ${recipients.length} kontak label "${ctx.labelName}" (perkiraan ${estimateMins} menit).`);
    console.log(`▶ Broadcast to ${recipients.length} recipients`);

    const failed: string[] = [];
    for (const [i, jid] of recipients.entries()) {
      if (i > 0) await sleep(randomDelay());
      try {
        await ctx.getSock().sendMessage(jid, content);
        console.log(`  ✓ [${i + 1}/${recipients.length}] ${jid}`);
      } catch (error) {
        failed.push(displayNumber(jid));
        console.error(`  ✗ [${i + 1}/${recipients.length}] ${jid}:`, error);
      }
    }

    const sent = recipients.length - failed.length;
    await reply(`✓ Broadcast selesai: ${sent} terkirim, ${failed.length} gagal.` + (failed.length ? `\nGagal: ${failed.join(', ')}` : ''));
  } catch (error) {
    console.error('✗ Broadcast error:', error);
    await reply(`✗ Broadcast gagal: ${(error as Error).message}`);
  } finally {
    running = false;
  }
  return true;
}
