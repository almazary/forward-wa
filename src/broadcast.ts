import { WASocket, WAMessage, SignalKeyStore, ChatMutation, LTHashState, S_WHATSAPP_NET, downloadMediaMessage, areJidsSameUser, jidNormalizedUser, extractSyncdPatches, decodeSyncdSnapshot, decodePatches, newLTHashState } from '@whiskeysockets/baileys';
import P from 'pino';

const COMMAND = /^\/bc(?:\s+|$)/i;
const MIN_DELAY_MS = 10_000;
const MAX_DELAY_MS = 30_000;

interface BroadcastContext {
  getSock: () => WASocket;
  keys: SignalKeyStore;
  listName: string;
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

const MAX_SYNC_ROUNDS = 10;

// WhatsApp Business broadcast lists live in the "regular" app state collection,
// but Baileys emits no event for them, so fetch and decode a fresh snapshot ourselves.
// This is read-only: the bot's own app state version is left untouched.
async function fetchBroadcastList(ctx: BroadcastContext): Promise<string[] | null> {
  const sock = ctx.getSock();
  const getKey = async (keyId: string) => (await ctx.keys.get('app-state-sync-key', [keyId]))[keyId];
  const mutations: Record<string, ChatMutation> = {};
  let state: LTHashState | undefined;

  for (let round = 0; round < MAX_SYNC_ROUNDS; round++) {
    const result = await sock.query({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, xmlns: 'w:sync:app:state', type: 'set' },
      content: [{
        tag: 'sync',
        attrs: {},
        content: [{ tag: 'collection', attrs: { name: 'regular', version: String(state?.version ?? 0), return_snapshot: String(!state) } }]
      }]
    });
    const { snapshot, patches, hasMorePatches } = (await extractSyncdPatches(result, {})).regular;
    if (snapshot) {
      const decoded = await decodeSyncdSnapshot('regular', snapshot, getKey, undefined, false);
      state = decoded.state;
      Object.assign(mutations, decoded.mutationMap);
    }
    if (patches.length) {
      const decoded = await decodePatches('regular', patches, state || newLTHashState(), getKey, {}, undefined, ctx.logger, false);
      state = decoded.state;
      Object.assign(mutations, decoded.mutationMap);
    }
    if (!hasMorePatches) break;
  }

  const wanted = ctx.listName.toLowerCase();
  const list = Object.values(mutations)
    .map(m => m.index[0] === 'business_broadcast_list' ? m.syncAction.value?.businessBroadcastListAction : undefined)
    .find(a => a && !a.deleted && a.listName?.toLowerCase() === wanted);
  if (!list) return null;

  // Prefer the phone number JID; dedupe in case a participant is listed twice
  const recipients = new Set<string>();
  for (const p of list.participants || []) {
    const jid = p.pnJid || p.lidJid;
    if (jid) recipients.add(jidNormalizedUser(jid));
  }
  return [...recipients];
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
    const recipients = await fetchBroadcastList(ctx);
    if (!recipients) {
      await reply(`✗ Daftar siaran "${ctx.listName}" tidak ditemukan.`);
      return true;
    }

    const hasMedia = !!(msg.message?.imageMessage || msg.message?.videoMessage);
    if (!body && !hasMedia) {
      const list = recipients.map((jid, i) => `${i + 1}. ${displayNumber(jid)}`).join('\n');
      await reply(`Daftar siaran "${ctx.listName}" berisi ${recipients.length} kontak:\n${list}\n\nKirim "/bc isi pesan" untuk broadcast.`);
      return true;
    }

    const content = await buildContent(ctx, msg, body);
    const estimateMins = Math.ceil(recipients.length * (MIN_DELAY_MS + MAX_DELAY_MS) / 2 / 60000);
    await reply(`▶ Mulai broadcast ke ${recipients.length} kontak daftar siaran "${ctx.listName}" (perkiraan ${estimateMins} menit).`);
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
