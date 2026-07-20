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
const songCache = new Map<string, string>(); // cacheId -> perma_url
let cacheSeq = 0;

function cacheSong(permaUrl: string): string {
  const id = String(cacheSeq++ % 9999).padStart(4, '0');
  songCache.set(id, permaUrl);
  return id;
}

// ── User quality preferences ──────────────────────────────────────────────────
type Quality = '96' | '160' | '320';
const userQuality = new Map<number, Quality>(); // userId -> preferred quality
const DEFAULT_QUALITY: Quality = '320';

function getUserQuality(userId: number): Quality {
  return userQuality.get(userId) || DEFAULT_QUALITY;
}

const QUALITY_LABELS: Record<Quality, string> = {
  '96':  '📻 96 kbps  — Yengil',
  '160': '🎧 160 kbps — O\'rta',
  '320': '🔊 320 kbps — Yuqori',
};

function buildQualityKeyboard(current: Quality): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  (Object.keys(QUALITY_LABELS) as Quality[]).forEach((q) => {
    const check = current === q ? '✅ ' : '';
    keyboard.text(`${check}${QUALITY_LABELS[q]}`, `setq_${q}`).row();
  });
  return keyboard;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeMd(text: string = ''): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function formatDuration(secStr: string | number): string {
  const s = parseInt(String(secStr), 10) || 0;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

// ── /start ────────────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  const welcomeText =
    `🎧 *JioSaavn Music Downloader Bot*\\!\n\n` +
    `Menga qo'shiq nomini yozing yoki JioSaavn havolasini yuboring\\.\n\n` +
    `*Buyruqlar:*\n` +
    `• /quality — musiqa sifatini sozlash\n\n` +
    `*Misollar:*\n` +
    `• \`Blinding Lights\`\n` +
    `• \`Tum Hi Ho\`\n` +
    `• \`https://www.jiosaavn.com/song/blinding-lights/Fj9GfAxDWUY\``;

  await ctx.reply(welcomeText, { parse_mode: 'MarkdownV2' });
});

// ── /quality ──────────────────────────────────────────────────────────────────
bot.command('quality', async (ctx) => {
  const userId = ctx.from?.id ?? 0;
  const current = getUserQuality(userId);

  await ctx.reply(
    `🎚 *Musiqa sifatini tanlang*\n\nHozirgi sifat: *${escapeMd(QUALITY_LABELS[current])}*`,
    { parse_mode: 'MarkdownV2', reply_markup: buildQualityKeyboard(current) }
  );
});

// ── Callback queries ──────────────────────────────────────────────────────────
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const userId = ctx.from?.id ?? 0;

  // ── Quality selection ────────────────────────────────────────────────────
  if (data.startsWith('setq_')) {
    const selected = data.replace('setq_', '') as Quality;

    if (!['96', '160', '320'].includes(selected)) {
      await ctx.answerCallbackQuery({ text: '❌ Noto\'g\'ri sifat.' });
      return;
    }

    userQuality.set(userId, selected);

    await ctx.editMessageText(
      `🎚 *Musiqa sifati saqlandi\\!*\n\nHozirgi sifat: *${escapeMd(QUALITY_LABELS[selected])}*`,
      { parse_mode: 'MarkdownV2', reply_markup: buildQualityKeyboard(selected) }
    );
    await ctx.answerCallbackQuery({ text: `✅ ${selected} kbps tanlandi!` });
    return;
  }

  // ── Song download ────────────────────────────────────────────────────────
  if (data.startsWith('dl_')) {
    const cacheId = data.replace('dl_', '');
    const permaUrl = songCache.get(cacheId);

    if (!permaUrl) {
      await ctx.answerCallbackQuery({ text: '⚠️ Musiqa eskirgan. Qayta qidiring.' });
      return;
    }

    const quality = getUserQuality(userId);
    await ctx.answerCallbackQuery({ text: `⬇️ ${quality} kbps sifatida yuklanmoqda…` });
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
      const audioUrl = getQualityUrl(rawMediaUrl, quality);

      const title = song.title || 'Unknown Track';
      const performer =
        song.more_info?.artists?.primary?.map((a: any) => a.name).join(', ') ||
        song.subtitle ||
        'JioSaavn';
      const duration = parseInt(song.more_info?.duration, 10) || 0;
      const thumbUrl = song.image ? song.image.replace(/150x150|50x50/, '500x500') : undefined;

      const caption =
        `🎵 *${escapeMd(title)}*\n` +
        `👤 ${escapeMd(performer)}\n` +
        `🔊 ${quality} kbps\n\n` +
        `🤖 @saavnmusicbot`;

      try {
        await ctx.replyWithAudio(audioUrl, {
          title,
          performer,
          duration,
          thumbnail: thumbUrl,
          caption,
          parse_mode: 'MarkdownV2',
        });
      } catch {
        const audioBuffer = await axios.get(audioUrl, { responseType: 'arraybuffer' });
        const inputFile = new InputFile(Buffer.from(audioBuffer.data), `${title}.mp3`);
        await ctx.replyWithAudio(inputFile, { title, performer, duration, thumbnail: thumbUrl, caption, parse_mode: 'MarkdownV2' });
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

// ── Text Messages ─────────────────────────────────────────────────────────────
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();

  // ── JioSaavn direct URL ────────────────────────────────────────────────
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
      const keyboard = new InlineKeyboard().text('⬇️ Musiqani yuklab olish', `dl_${cacheId}`);

      const title = escapeMd(song.title);
      const artists = escapeMd(
        song.more_info?.artists?.primary?.map((a: any) => a.name).join(', ') || song.subtitle
      );
      const album = escapeMd(song.more_info?.album || '');
      const duration = formatDuration(song.more_info?.duration);
      const userId = ctx.from?.id ?? 0;
      const quality = getUserQuality(userId);

      const caption =
        `🎵 *${title}*\n` +
        `👤 *Xonanda:* ${artists}\n` +
        `💿 *Albom:* ${album}\n` +
        `⏱ *Davomiyligi:* ${duration}\n` +
        `🔊 *Sifat:* ${quality} kbps`;

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

  // ── Search query ────────────────────────────────────────────────────────
  const statusMsg = await ctx.reply('🔍 *Qidirilmoqda…*', { parse_mode: 'MarkdownV2' });
  const userId = ctx.from?.id ?? 0;
  const quality = getUserQuality(userId);

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
    let msgText =
      `🔍 "*${escapeMd(text)}*" bo'yicha natijalar \\(${quality} kbps\\):\n\n`;

    topResults.forEach((song: any, index: number) => {
      const title = song.title || 'Track';
      const artist =
        song.more_info?.artists?.primary?.map((a: any) => a.name).join(', ') ||
        song.subtitle ||
        '';
      const dur = formatDuration(song.more_info?.duration);

      msgText += `${index + 1}\\. *${escapeMd(title)}*\n   👤 ${escapeMd(artist)} \\(${dur}\\)\n\n`;

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
