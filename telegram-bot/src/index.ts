import { Bot, InlineKeyboard, InputFile } from 'grammy';
import axios from 'axios';
import dotenv from 'dotenv';
import { decryptMediaUrl, getQualityUrl } from './decrypt.js';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN || '8922942398:AAFsRjiocyDI7sCXDsfszkJvvzUrCzygeO4';
const SEARCH_API = process.env.SEARCH_API || 'https://jiosaavn-api-eight-sigma.vercel.app/api/songs?q=';
const BASE_API = SEARCH_API.replace('/songs?q=', ''); // typically https://jiosaavn-api-eight-sigma.vercel.app/api
const SONG_API = process.env.SONG_API || 'https://sda.ymkhdv.workers.dev/song';

const bot = new Bot(BOT_TOKEN);

// ── Caches (solves Telegram's 64-byte callback_data limit) ────────────────────
const songCache = new Map<string, string>(); // cacheId -> perma_url
let songSeq = 0;

function cacheSong(permaUrl: string): string {
  const id = String(songSeq++ % 9999).padStart(4, '0');
  songCache.set(id, permaUrl);
  return id;
}

const searchCache = new Map<string, string>(); // searchId -> query string
let searchSeq = 0;

function cacheSearch(query: string): string {
  for (const [k, v] of searchCache.entries()) {
    if (v === query) return k;
  }
  const id = String(searchSeq++ % 9999).padStart(4, '0');
  searchCache.set(id, query);
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

async function downloadAndSendAudio(ctx: any, permaUrl: string, quality: Quality): Promise<boolean> {
  try {
    const resp = await axios.get(`${SONG_API}?url=${encodeURIComponent(permaUrl)}`);
    const song = resp.data;

    if (!song?.more_info?.encrypted_media_url) return false;

    const rawMediaUrl = decryptMediaUrl(song.more_info.encrypted_media_url);
    const audioUrl = getQualityUrl(rawMediaUrl, quality);

    const title = song.title || 'Unknown Track';
    const performer = song.more_info?.artists?.primary?.map((a: any) => a.name).join(', ') || song.subtitle || 'JioSaavn';
    const duration = parseInt(song.more_info?.duration, 10) || 0;
    const thumbUrl = song.image ? song.image.replace(/150x150|50x50/, '500x500') : undefined;

    const caption = `🎵 *${escapeMd(title)}*\n👤 ${escapeMd(performer)}\n🔊 ${quality} kbps\n\n🤖 @saavnmusicbot`;

    try {
      await ctx.replyWithAudio(audioUrl, { title, performer, duration, thumbnail: thumbUrl, caption, parse_mode: 'MarkdownV2' });
    } catch {
      const audioBuffer = await axios.get(audioUrl, { responseType: 'arraybuffer' });
      const inputFile = new InputFile(Buffer.from(audioBuffer.data), `${title}.mp3`);
      await ctx.replyWithAudio(inputFile, { title, performer, duration, thumbnail: thumbUrl, caption, parse_mode: 'MarkdownV2' });
    }
    return true;
  } catch (err) {
    console.error('Download error:', err);
    return false;
  }
}

type SearchType = 'song' | 'album' | 'artist';

async function renderSearch(
  ctx: any,
  query: string,
  type: SearchType,
  page: number,
  quality: Quality,
  messageId?: number
) {
  const url = `${BASE_API}/${type}s?q=${encodeURIComponent(query)}&page=${page}`;
  
  try {
    const resp = await axios.get(url);
    const results = resp.data?.results || [];

    if (!Array.isArray(results) || results.length === 0) {
      const emptyMsg = `❌ "*${escapeMd(query)}*" bo'yicha hech narsa topilmadi\\.`;
      if (messageId) {
        await ctx.api.editMessageText(ctx.chat.id, messageId, emptyMsg, { parse_mode: 'MarkdownV2' });
      } else {
        await ctx.reply(emptyMsg, { parse_mode: 'MarkdownV2' });
      }
      return;
    }

    const keyboard = new InlineKeyboard();
    let msgText = `🔍 "*${escapeMd(query)}*" bo'yicha natijalar \\(${type === 'song' ? 'Qo\'shiq' : type === 'album' ? 'Albom' : 'Xonanda'}, ${page}\\-sahifa\\):\n\n`;

    const searchId = cacheSearch(query);
    const limit = 8;
    const topResults = results.slice(0, limit);

    if (type === 'song') {
      topResults.forEach((song: any, index: number) => {
        const title = song.title || 'Track';
        const artist = song.more_info?.artists?.primary?.map((a: any) => a.name).join(', ') || song.subtitle || '';
        const cacheId = cacheSong(song.perma_url || song.track_url);
        const btnText = artist ? `${artist} - ${title}` : title;
        keyboard.text(`🎵 ${index + 1}. ${btnText.slice(0, 45)}`, `dl_${cacheId}`).row();
      });
    } else if (type === 'album') {
      topResults.forEach((album: any, index: number) => {
        const title = album.title || 'Album';
        const subtitle = album.subtitle || '';
        const btnText = subtitle ? `${title} - ${subtitle}` : title;
        keyboard.text(`💿 ${index + 1}. ${btnText.slice(0, 45)}`, `al_${album.token}`).row();
      });
    } else if (type === 'artist') {
      topResults.forEach((artist: any, index: number) => {
        const name = artist.name || 'Artist';
        keyboard.text(`👤 ${index + 1}. ${name.slice(0, 45)}`, `ar_${artist.token}`).row();
      });
    }

    const total = resp.data?.total || 0;
    const hasNext = page * 10 < total; // Usually JioSaavn returns 10 items per page
    
    // Row 1: Pagination
    if (page > 1) {
      keyboard.text('⬅️ Orqaga', `sp_${searchId}_${type}_${page - 1}`);
    }
    keyboard.text('❌ Yopish', 'close_msg');
    if (hasNext || results.length > limit) {
      keyboard.text('Oldinga ➡️', `sp_${searchId}_${type}_${page + 1}`);
    }
    keyboard.row();

    // Row 2: Filters
    if (type !== 'song') keyboard.text('🎵 Qo\'shiqlar', `sp_${searchId}_song_1`);
    if (type !== 'album') keyboard.text('💿 Albomlar', `sp_${searchId}_album_1`);
    if (type !== 'artist') keyboard.text('👤 Xonandalar', `sp_${searchId}_artist_1`);
    keyboard.row();

    if (messageId) {
      await ctx.api.editMessageText(ctx.chat.id, messageId, msgText, {
        parse_mode: 'MarkdownV2',
        reply_markup: keyboard,
      });
    } else {
      await ctx.reply(msgText, {
        parse_mode: 'MarkdownV2',
        reply_markup: keyboard,
      });
    }
  } catch (err) {
    console.error('Search rendering error:', err);
    const errMsg = '❌ *Qidiruvda xatolik yuz berdi\\. Keyinroq qaytadan urinib ko\'ring\\.*';
    if (messageId) {
      await ctx.api.editMessageText(ctx.chat.id, messageId, errMsg, { parse_mode: 'MarkdownV2' });
    } else {
      await ctx.reply(errMsg, { parse_mode: 'MarkdownV2' });
    }
  }
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

  // ── Close Message ────────────────────────────────────────────────────────
  if (data === 'close_msg') {
    await ctx.deleteMessage().catch(() => {});
    return;
  }

  // ── Search Pagination & Filter ───────────────────────────────────────────
  if (data.startsWith('sp_')) {
    const parts = data.split('_');
    const searchId = parts[1];
    const type = parts[2] as SearchType;
    const page = parseInt(parts[3], 10);
    
    const query = searchCache.get(searchId);
    if (!query) {
      await ctx.answerCallbackQuery({ text: '⚠️ Qidiruv eskirgan. Qayta qidiring.' });
      return;
    }
    
    const quality = getUserQuality(userId);
    await renderSearch(ctx, query, type, page, quality, ctx.callbackQuery.message?.message_id);
    await ctx.answerCallbackQuery();
    return;
  }

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

  // ── Album Fetch ──────────────────────────────────────────────────────────
  if (data.startsWith('al_')) {
    const token = data.replace('al_', '');
    const statusMsg = await ctx.reply('⏳ *Albom yuklanmoqda…*', { parse_mode: 'MarkdownV2' });
    await ctx.answerCallbackQuery().catch(() => {});
    
    try {
      const resp = await axios.get(`${BASE_API}/album?token=${token}`);
      const album = resp.data;
      if (!album || !album.songs || album.songs.length === 0) {
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '⚠️ *Ushbu albom musiqalari JioSaavn manbasida topilmadi\\.*', { parse_mode: 'MarkdownV2' });
        return;
      }
      
      const keyboard = new InlineKeyboard();
      let msgText = `💿 *${escapeMd(album.title)}*\n👤 ${escapeMd(album.subtitle || album.header_desc)}\n\n*Qo'shiqlar:*\n\n`;
      
      album.songs.forEach((song: any, index: number) => {
        const title = song.title || 'Track';
        const dur = formatDuration(song.more_info?.duration || song.duration);
        msgText += `${index + 1}\\. *${escapeMd(title)}* \\(${dur}\\)\n`;
        const cacheId = cacheSong(song.perma_url || song.track_url);
        keyboard.text(`🎵 ${index + 1}. ${title.slice(0, 45)}`, `dl_${cacheId}`).row();
      });
      
      keyboard.text('📥 Hammasini yuklab olish', `dla_${token}`).row();
      keyboard.text('❌ Yopish', 'close_msg');
      
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, msgText, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
    } catch (err) {
      console.error('Album fetch error:', err);
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '❌ *Albomni yuklab bo\'lmadi\\.*', { parse_mode: 'MarkdownV2' });
    }
    return;
  }

  // ── Artist Fetch ─────────────────────────────────────────────────────────
  if (data.startsWith('ar_')) {
    const token = data.replace('ar_', '');
    const statusMsg = await ctx.reply(`⏳ *Xonanda ma'lumotlari yuklanmoqda…*`, { parse_mode: 'MarkdownV2' });
    await ctx.answerCallbackQuery().catch(() => {});
    
    try {
      const resp = await axios.get(`${BASE_API}/artist?token=${token}`);
      const artist = resp.data;
      if (!artist || !artist.name) {
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `⚠️ *Xonanda ma'lumotlari topilmadi\\.*`, { parse_mode: 'MarkdownV2' });
        return;
      }
      
      const keyboard = new InlineKeyboard();
      const msgText = `👤 *${escapeMd(artist.name)}*\n\nMa'lumotlarni tanlang:`;
      
      keyboard.text('🔥 TOP 10', `artop_${token}`).row();
      keyboard.text('💿 Albomlar', `aralb_${token}`).row();
      keyboard.text('❌ Yopish', 'close_msg');
      
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, msgText, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
    } catch (err) {
      console.error('Artist fetch error:', err);
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `❌ *Xonanda ma'lumotlarini yuklab bo'lmadi\\.*`, { parse_mode: 'MarkdownV2' });
    }
    return;
  }

  // ── Artist TOP 10 Fetch ──────────────────────────────────────────────────
  if (data.startsWith('artop_')) {
    const token = data.replace('artop_', '');
    const statusMsg = await ctx.reply(`⏳ *Top 10 qo'shiqlar yuklanmoqda…*`, { parse_mode: 'MarkdownV2' });
    await ctx.answerCallbackQuery().catch(() => {});
    
    try {
      const resp = await axios.get(`${BASE_API}/artist?token=${token}`);
      const artist = resp.data;
      if (!artist || !artist.topSongs || artist.topSongs.length === 0) {
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '⚠️ *Ushbu xonanda musiqalari JioSaavn manbasida topilmadi\\.*', { parse_mode: 'MarkdownV2' });
        return;
      }
      
      const keyboard = new InlineKeyboard();
      let msgText = `👤 *${escapeMd(artist.name)}*\n🔥 *TOP 10 qo'shiqlari:*\n\n`;
      
      artist.topSongs.slice(0, 10).forEach((song: any, index: number) => {
        const title = song.title || 'Track';
        const dur = formatDuration(song.duration || song.more_info?.duration);
        msgText += `${index + 1}\\. *${escapeMd(title)}* \\(${dur}\\)\n`;
        const cacheId = cacheSong(song.perma_url || song.track_url);
        keyboard.text(`🎵 ${index + 1}. ${title.slice(0, 45)}`, `dl_${cacheId}`).row();
      });
      
      keyboard.text('💿 Albomlar', `aralb_${token}`).row();
      keyboard.text('❌ Yopish', 'close_msg');
      
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, msgText, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
    } catch (err) {
      console.error('Artist Top 10 fetch error:', err);
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `❌ *Qo'shiqlarni yuklab bo'lmadi\\.*`, { parse_mode: 'MarkdownV2' });
    }
    return;
  }

  // ── Artist Albums Fetch ──────────────────────────────────────────────────
  if (data.startsWith('aralb_')) {
    const token = data.replace('aralb_', '');
    const statusMsg = await ctx.reply(`⏳ *Albomlar yuklanmoqda…*`, { parse_mode: 'MarkdownV2' });
    await ctx.answerCallbackQuery().catch(() => {});
    
    try {
      const resp = await axios.get(`${BASE_API}/artist?token=${token}`);
      const artist = resp.data;
      
      const allAlbums = [
        ...(artist.topAlbums || []),
        ...(artist.latest_release || []),
        ...(artist.singles || [])
      ];
      
      const uniqueAlbums = Array.from(new Map(allAlbums.map(a => [a.token, a])).values());
      
      if (!uniqueAlbums || uniqueAlbums.length === 0) {
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `⚠️ *Ushbu xonanda uchun albomlar topilmadi\\.*`, { parse_mode: 'MarkdownV2' });
        return;
      }
      
      const keyboard = new InlineKeyboard();
      let msgText = `👤 *${escapeMd(artist.name)}* — 💿 *Albom va Singllari:*\n\n`;
      
      uniqueAlbums.slice(0, 15).forEach((album: any, index: number) => {
        const title = album.title || 'Album';
        const btnText = title;
        keyboard.text(`💿 ${index + 1}. ${btnText.slice(0, 45)}`, `al_${album.token}`).row();
      });
      
      keyboard.text('⬅️ Orqaga', `ar_${token}`).row();
      keyboard.text('❌ Yopish', 'close_msg');
      
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, msgText, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
    } catch (err) {
      console.error('Artist Albums fetch error:', err);
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `❌ *Albomlarni yuklab bo'lmadi\\.*`, { parse_mode: 'MarkdownV2' });
    }
    return;
  }

  // ── Download All (Album & Artist) ────────────────────────────────────────
  if (data.startsWith('dla_') || data.startsWith('dlar_')) {
    const isArtist = data.startsWith('dlar_');
    const token = data.replace(isArtist ? 'dlar_' : 'dla_', '');
    
    await ctx.answerCallbackQuery({ text: '⏳ Barcha musiqalar yuklanmoqda...' });
    const statusMsg = await ctx.reply('⏳ *Musiqalar tayyorlanmoqda…*', { parse_mode: 'MarkdownV2' });
    
    try {
      const url = isArtist ? `${BASE_API}/artist?token=${token}` : `${BASE_API}/album?token=${token}`;
      const resp = await axios.get(url);
      const items = isArtist ? resp.data?.topSongs : resp.data?.songs;
      
      if (!items || !Array.isArray(items) || items.length === 0) {
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '❌ *Musiqalar topilmadi\\.*', { parse_mode: 'MarkdownV2' });
        return;
      }
      
      const quality = getUserQuality(userId);
      let successCount = 0;
      
      for (let i = 0; i < items.length; i++) {
        await ctx.api.editMessageText(
          ctx.chat!.id, 
          statusMsg.message_id, 
          `⏳ *Yuklanmoqda: ${i + 1} / ${items.length}*`, 
          { parse_mode: 'MarkdownV2' }
        ).catch(() => {});
        
        const permaUrl = items[i].perma_url || items[i].track_url || items[i].url;
        if (permaUrl) {
          const ok = await downloadAndSendAudio(ctx, permaUrl, quality);
          if (ok) successCount++;
        }
      }
      
      await ctx.api.editMessageText(
        ctx.chat!.id, 
        statusMsg.message_id, 
        `✅ *Yakunlandi! ${successCount}/${items.length} ta musiqa yuklandi.*`, 
        { parse_mode: 'MarkdownV2' }
      ).catch(() => {});
      
    } catch (err) {
      console.error('Download All error:', err);
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, '❌ *Kutilmagan xatolik yuz berdi\\.*', { parse_mode: 'MarkdownV2' }).catch(() => {});
    }
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

    const ok = await downloadAndSendAudio(ctx, permaUrl, quality);
    if (ok) {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
    } else {
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
  await renderSearch(ctx, text, 'song', 1, quality, statusMsg.message_id);
});

// ── Global error handler (prevents crash loops) ───────────────────────────────
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Error while handling update ${ctx.update.update_id}:`, err.error);
});

// ── Launch ────────────────────────────────────────────────────────────────────
bot.start();
console.log('🤖 JioSaavn Telegram Bot is running...');
