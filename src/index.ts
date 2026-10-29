import makeWASocket, { DisconnectReason, useMultiFileAuthState, WASocket, proto, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import P from 'pino';
import qrcode from 'qrcode-terminal';
import { loadConfig } from './config';
import { MessageStore } from './messageStore';
import { handleBroadcastCommand, isSelfChat } from './broadcast';

const logger = P({ level: 'silent' });
const config = loadConfig();
const messageStore = new MessageStore();
// Always points at the latest socket, so timers and broadcasts survive reconnects
let currentSock: WASocket;

function formatMessage(from: string, timestamp: number, pushName?: string, sender?: string): string {
  const diffMins = Math.floor((Date.now() - timestamp) / 60000);
  const elapsed = `${diffMins} menit`;
  
  // Use sender (participant) if available, otherwise use from (remoteJid)
  const jid = sender || from;
  
  // Extract clean number from various WhatsApp formats
  let number = jid.replace('@s.whatsapp.net', '')
                  .replace('@lid', '')
                  .replace('@g.us', '')
                  .split(':')[0];
  
  const senderName = pushName ? `${pushName} (${number})` : number;
  
  return `Ada pesan baru dari ${senderName} sejak ${elapsed} yang lalu.`;
}

function extractMessageText(message: proto.IMessage | null | undefined): string {
  if (!message) return '';
  return message.conversation || 
         message.extendedTextMessage?.text || 
         '[Media/Other]';
}

async function forwardMessage(messageId: string): Promise<void> {
  const pending = messageStore.get(messageId);
  if (!pending) return;

  try {
    const formattedText = formatMessage(pending.from, pending.timestamp, pending.pushName, pending.sender);
    
    await currentSock.sendMessage(`${config.forwardToNumber}@s.whatsapp.net`, {
      text: formattedText
    });
    
    console.log(`✓ Forwarded message from ${pending.from}`);
  } catch (error) {
    console.error(`✗ Failed to forward message:`, error);
  }
}

async function startWhatsApp(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();
  const keys = makeCacheableSignalKeyStore(state.keys, logger);
  
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys
    },
    logger
  });
  currentSock = sock;

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log('\n=== Scan QR code dengan WhatsApp di HP Anda ===\n');
      qrcode.generate(qr, { small: true });
    }
    
    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log('Connection closed.');
      if (lastDisconnect?.error) {
        console.log('Error:', (lastDisconnect.error as any).message || lastDisconnect.error);
      }
      console.log('Reconnecting:', shouldReconnect);
      
      if (shouldReconnect) {
        setTimeout(() => startWhatsApp(), 5000);
      }
    } else if (connection === 'open') {
      console.log('\n✓ Connected to WhatsApp\n');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe && isSelfChat(sock, msg.key.remoteJid)) {
        handleBroadcastCommand({ getSock: () => currentSock, keys, listName: config.broadcastList, logger }, msg)
          .catch(err => console.error('✗ Broadcast command error:', err));
        continue;
      }
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;

      const messageId = msg.key.id;
      const from = msg.key.remoteJid || '';
      // Use remoteJidAlt for actual phone number, or participant for group messages, or fallback to remoteJid
      const sender = msg.key.remoteJidAlt || msg.key.participant || from;
      
      if (!messageId) continue;

      if (messageStore.hasPendingFrom(from)) {
        console.log(`⏭ Skipping message from ${from}, already has pending forward`);
        continue;
      }

      const text = extractMessageText(msg.message);
      if (text === '[Media/Other]' && !msg.message.conversation && !msg.message.extendedTextMessage) {
        // skip protocol/system messages
        if (!msg.message.imageMessage && !msg.message.videoMessage && 
            !msg.message.audioMessage && !msg.message.documentMessage) continue;
      }

      console.log(`→ New message from ${from}: ${text.substring(0, 50)}`);

      const pushName = msg.pushName || undefined;
      const timeoutMs = config.timeoutMinutes * 60 * 1000;
      messageStore.add(messageId, msg, from, timeoutMs, () => {
        forwardMessage(messageId);
      }, pushName, sender);
    }
  });

  sock.ev.on('messages.update', (updates) => {
    for (const update of updates) {
      const messageId = update.key.id;
      if (!messageId) continue;

      console.log(`↻ Message update [${messageId}] status: ${update.update.status}`);

      if (update.update.status === 4) { // Status 4 = read
        const pending = messageStore.get(messageId);
        if (pending) {
          console.log(`✓ Message read, canceling forward: ${messageId}`);
          messageStore.remove(messageId);
        }
      }
    }
  });
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  messageStore.cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  messageStore.cleanup();
  process.exit(0);
});

// Validate config
if (!config.forwardToNumber) {
  console.error('Error: FORWARD_TO_NUMBER not set in .env');
  process.exit(1);
}

console.log(`Starting WhatsApp Forward Bot`);
console.log(`Forward to: ${config.forwardToNumber}`);
console.log(`Timeout: ${config.timeoutMinutes} minutes`);
console.log(`Broadcast list: ${config.broadcastList}\n`);

startWhatsApp().catch(console.error);
