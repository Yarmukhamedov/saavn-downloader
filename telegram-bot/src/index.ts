import { Bot, InlineKeyboard, InputFile } from 'grammy';
import axios from 'axios';
import dotenv from 'dotenv';
import { decryptMediaUrl, getQualityUrl } from './decrypt.js';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN || '8922942398:AAFsRjiocyDI7sCXDsfszkJvvzUrCzygeO4';
const SEARCH_API = process.env.SEARCH_API || 'https://jiosaavn-api-eight-sigma.vercel.app/api/songs?q=';
const SONG_API = process.env.SONG_API || 'https://sda.ymkhdv.workers.dev/song';

const bot = new Bot(BOT_TOKEN);

// ── Song cache (solves Telegram's 64-byte callback_data limit) ────────────────
// Instead of storing the full URL in callback_data, we store a short numeric ID
// and look up the full URL from this map.
const songCache = new Map<string, string>(); // cacheId -> perma_url
let cacheSeq = 0;

function cacheSong(permaUrl: string): string {
  const id = String(cacheSeq++ % 9999).padStart(4, '0');
  songCache.set(id, permaUrl);
  return id; // e.g. "0042" → callback_data: "dl_0042" (7 bytes, well under 64)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Escape MarkdownV2 special characters
function escapeMd(text: string = ''): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// Format seconds into MM:SS
function formatDuration(secStr: string | number): string {
  const s = parseInt(String(secStr), 10) || 0;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

// ── Start Command ─────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  const welcomeText =
    `🎧 *JioSaavn Music Downloader Bot*\\!\n\n` +
    `Menga qo'shiq nomini yozing yoki JioSaavn havolasini yuboring\\.\n\n` +
    `*Misollar:*\n` +
    `• \`Blinding Lights\`\n` +
    `• \`Tum Hi Ho\`\n` +
    `• \`https://www.jiosaavn.com/song/blinding-lights/Fj9GfAxDWUY\``;

  await ctx.reply(welcomeText, { parse_mode: 'MarkdownV2' });
});

// ── Callback Query (Download song) ───────────────────────────────────────────
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;

  if (data.startsWith('dl_')) {
    const cacheId = data.replace('dl_', '');
    const permaUrl = songCache.get(cacheId);

    if (!permaUrl) {
      await ctx.answerCallbackQuery({ text: '⚠️ Musiqa eskirgan. Qayta qidiring.' });
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Musiqa yuklanmoqda...' });
    const statusMsg = await ctx.reply('⏳ *Musiqa tayyorlanmoqda, kuting…*', { parse_mode: 'MarkdownV2' });

    try {
      const resp = await axios.get(`${SONG_API}?url=${encodeURIComponent(permaUrl)}`);
      const song = resp.data;

      if (!song?.more_info?.encrypted_media_url) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          statusMsg.message_id,
          '❌ *Musiqa ma\'lumotlarini olib bo\'lmadi\\.*',
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }

      const rawMediaUrl = decryptMediaUrl(song.more_info.encrypted_media_url);
      const audioUrl = getQualityUrl(rawMediaUrl, '320');

      const title = song.title || 'Unknown Track';
      const performer =
        song.more_info?.artists?.primary?.map((a: any) => a.name).join(', ') ||
        song.subtitle ||
        'JioSaavn';
      const duration = parseInt(song.more_info?.duration, 10) || 0;
      const thumbUrl = song.image ? song.image.replace(/150x150|50x50/, '500x500') : undefined;

      // Try sending via URL first (fast path)
      try {
        await ctx.replyWithAudio(audioUrl, {
          title,
          performer,
          duration,
          thumbnail: thumbUrl,
          caption: `🎵 *${escapeMd(title)}*\n👤 ${escapeMd(performer)}\n\n🤖 @saavnmusicbot`,
          parse_mode: 'MarkdownV2',
        });
      } catch {
        // Fallback: download buffer and send
        const audioBuffer = await axios.get(audioUrl, { responseType: 'arraybuffer' });
        const inputFile = new InputFile(Buffer.from(audioBuffer.data), `${title}.mp3`);
        await ctx.replyWithAudio(inputFile, {
          title,
          performer,
          duration,
          thumbnail: thumbUrl,
          caption: `🎵 *${escapeMd(title)}*\n👤 ${escapeMd(performer)}\n\n🤖 @saavnmusicbot`,
          parse_mode: 'MarkdownV2',
        });
      }

      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
    } catch (err) {
      console.error('Download error:', err);
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        '❌ *Musiqani yuklab bo\'lmadi\\. Qaytadan urinib ko\'ring\\.*',
        { parse_mode: 'MarkdownV2' }
      );
    }
  }
});

// ── Text Messages (Search or URL input) ──────────────────────────────────────
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();

  // ── JioSaavn direct URL ───────────────────────────────────────────────────
  if (text.includes('jiosaavn.com/song/')) {
    const statusMsg = await ctx.reply('⏳ *Musiqa ma\'lumotlari olinmoqda…*', { parse_mode: 'MarkdownV2' });

    try {
      const resp = await axios.get(`${SONG_API}?url=${encodeURIComponent(text)}`);
      const song = resp.data;

      if (!song?.id) {
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, '❌ *Musiqa topilmadi\\.*', { parse_mode: 'MarkdownV2' });
        return;
      }

      const cacheId = cacheSong(song.perma_url);
      const keyboard = new InlineKeyboard().text('⬇️ Musiqani yuklab olish (320 kbps)', `dl_${cacheId}`);

      const title = escapeMd(song.title);
      const artists = escapeMd(
        song.more_info?.artists?.primary?.map((a: any) => a.name).join(', ') || song.subtitle
      );
      const album = escapeMd(song.more_info?.album || '');
      const duration = formatDuration(song.more_info?.duration);

      const caption =
        `🎵 *${title}*\n` +
        `👤 *Xonanda:* ${artists}\n` +
        `💿 *Albom:* ${album}\n` +
        `⏱ *Davomiyligi:* ${duration}`;

      if (song.image) {
        await ctx.replyWithPhoto(song.image.replace(/150x150|50x50/, '500x500'), {
          caption,
          parse_mode: 'MarkdownV2',
          reply_markup: keyboard,
        });
        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      } else {
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, caption, {
          parse_mode: 'MarkdownV2',
          reply_markup: keyboard,
        });
      }
    } catch (err) {
      console.error('URL fetch error:', err);
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        '❌ *Musiqani olishda xatolik yuz berdi\\.*',
        { parse_mode: 'MarkdownV2' }
      );
    }
    return;
  }

  // ── Search query ──────────────────────────────────────────────────────────
  const statusMsg = await ctx.reply('🔍 *Qidirilmoqda…*', { parse_mode: 'MarkdownV2' });

  try {
    const resp = await axios.get(`${SEARCH_API}${encodeURIComponent(text)}`);
    const results = resp.data?.results || [];

    if (!Array.isArray(results) || results.length === 0) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `❌ "*${escapeMd(text)}*" bo'yicha hech narsa topilmadi\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    const topResults = results.slice(0, 8);
    const keyboard = new InlineKeyboard();
    let msgText = `🔍 "*${escapeMd(text)}*" bo'yicha qidiruv natijalari:\n\n`;

    topResults.forEach((song: any, index: number) => {
      const title = song.title || 'Track';
      const artist =
        song.more_info?.artists?.primary?.map((a: any) => a.name).join(', ') ||
        song.subtitle ||
        '';
      const dur = formatDuration(song.more_info?.duration);

      msgText += `${index + 1}\\. *${escapeMd(title)}*\n   👤 ${escapeMd(artist)} \\(${dur}\\)\n\n`;

      // Use short cache ID (max 7 bytes: "dl_XXXX") instead of full URL
      const cacheId = cacheSong(song.perma_url);
      keyboard.text(`🎵 ${index + 1}. ${title.slice(0, 25)}`, `dl_${cacheId}`).row();
    });

    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, msgText, {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard,
    });
  } catch (err) {
    console.error('Search error:', err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      '❌ *Qidiruvda xatolik yuz berdi\\. Keyinroq qaytadan urinib ko\'ring\\.*',
      { parse_mode: 'MarkdownV2' }
    );
  }
});

// ── Launch ────────────────────────────────────────────────────────────────────
bot.start();
console.log('🤖 JioSaavn Telegram Bot is running...');
