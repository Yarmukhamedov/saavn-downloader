import { Bot, InlineKeyboard, InputFile } from 'grammy';
import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import util from 'util';
import { execFile } from 'child_process';
import { decryptMediaUrl, getQualityUrl } from './decrypt.js';
import { Language, LANG_NAMES, t } from './i18n.js';

dotenv.config();

const execFilePromise = util.promisify(execFile);

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

// ── Deduplication Utility ───────────────────────────────────────────────────
function dedupeByKeys(items: any[]): any[] {
  if (!Array.isArray(items)) return [];
  const seenKeys = new Set<string>();
  const seenTitles = new Set<string>();

  return items.filter(item => {
    if (!item) return false;

    const idKey = item.id || item.token || item.perma_url || item.track_url || '';
    if (idKey && seenKeys.has(idKey)) {
      return false;
    }

    const rawTitle = (item.title || item.name || '').toLowerCase().trim();
    const cleanTitle = rawTitle.replace(/[\s\-_]+/g, '');
    const primaryArtist = (item.more_info?.artists?.primary?.map((a: any) => a.name).join('') || item.subtitle || '').toLowerCase().replace(/[\s\-_]+/g, '');
    const compositeTitleKey = `${cleanTitle}__${primaryArtist}`;

    if (cleanTitle && seenTitles.has(compositeTitleKey)) {
      return false;
    }

    if (idKey) seenKeys.add(idKey);
    if (cleanTitle) seenTitles.add(compositeTitleKey);

    return true;
  });
}

// ── User language preferences ─────────────────────────────────────────────────
const userLanguage = new Map<number, Language>();

function getUserLanguage(ctx: any): Language {
  const userId = ctx.from?.id ?? 0;
  if (userLanguage.has(userId)) {
    return userLanguage.get(userId)!;
  }
  const code = ctx.from?.language_code || '';
  if (code.startsWith('ru')) return 'ru';
  if (code.startsWith('en')) return 'en';
  return 'uz';
}

function buildLanguageKeyboard(current: Language): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const langs: Language[] = ['uz', 'ru', 'en'];
  langs.forEach((lang) => {
    const check = current === lang ? '🔹 ' : '';
    keyboard.text(`${check}${LANG_NAMES[lang]}`, `setlang_${lang}`).row();
  });
  keyboard.text(t(current, 'close'), 'close_msg').row();
  return keyboard;
}

// ── User quality preferences ──────────────────────────────────────────────────
type Quality = '96' | '160' | '320';
const userQuality = new Map<number, Quality>(); // userId -> preferred quality
const DEFAULT_QUALITY: Quality = '320';

function getUserQuality(userId: number): Quality {
  return userQuality.get(userId) || DEFAULT_QUALITY;
}

const QUALITY_LABELS: Record<Quality, string> = {
  '96':  '📻 96 kbps  — Low',
  '160': '🎧 160 kbps — Medium',
  '320': '🔊 320 kbps — High',
};

function buildQualityKeyboard(current: Quality, lang: Language = 'uz'): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  (Object.keys(QUALITY_LABELS) as Quality[]).forEach((q) => {
    const check = current === q ? '✅ ' : '';
    keyboard.text(`${check}${QUALITY_LABELS[q]}`, `setq_${q}`).row();
  });
  keyboard.text(t(lang, 'close'), 'close_msg').row();
  return keyboard;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractArtistToken(a: any): string {
  if (!a) return '';
  if (a.artist_token) return a.artist_token;
  if (a.token) return a.token;
  if (a.perma_url) {
    const parts = a.perma_url.trim().replace(/\/$/, '').split('/');
    return parts[parts.length - 1] || '';
  }
  return a.id || '';
}

function isItemByArtist(item: any, targetArtist: any): boolean {
  if (!item || !targetArtist) return false;

  const targetId = String(targetArtist.id || targetArtist.artistId || '').toLowerCase();
  const targetName = (targetArtist.name || '').trim().toLowerCase();
  if (!targetName && !targetId) return false;

  const targetVariants = [
    targetName,
    targetName.replace(/o/g, 'a'),
    targetName.replace(/a/g, 'o')
  ];

  // 1. Check artist objects array if available
  const artistList = [
    ...(item.artists?.primary || []),
    ...(item.artists?.featured || []),
    ...(item.artists?.all || []),
    ...(item.more_info?.artists?.primary || []),
    ...(item.more_info?.artists?.featured || []),
    ...(item.more_info?.artists?.all || []),
  ];

  for (const a of artistList) {
    if (targetId && a.id && String(a.id).toLowerCase() === targetId) return true;
    const aName = (a.name || '').trim().toLowerCase();
    if (aName && targetVariants.includes(aName)) return true;
  }

  // 2. Extract all raw artist text fields from JioSaavn item
  const rawFields = [
    item.primary_artists,
    item.subtitle,
    item.header_desc,
    item.music,
    item.artist,
    item.more_info?.music,
    item.more_info?.singers,
    item.more_info?.artistMap?.primary_artists?.map((a: any) => a.name).join(', '),
    item.more_info?.artistMap?.artists?.map((a: any) => a.name).join(', '),
  ].filter(Boolean);

  for (const rawArtists of rawFields) {
    const names = String(rawArtists)
      .split(/[,;&]|\bfeat\.?\b|\bft\.?\b|\band\b/i)
      .map((s: string) => s.trim().toLowerCase())
      .filter(Boolean);

    for (const n of names) {
      if (targetVariants.includes(n)) return true;
    }
  }

  return false;
}

async function editOrReplaceText(ctx: any, text: string, options: any) {
  try {
    await ctx.editMessageText(text, options);
  } catch (err) {
    await ctx.deleteMessage().catch(() => {});
    await ctx.reply(text, options);
  }
}

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
  let tmpAudioPath = '';
  let tmpImgPath = '';
  let tmpOutPath = '';
  try {
    const resp = await axios.get(`${SONG_API}?url=${encodeURIComponent(permaUrl)}`);
    const song = resp.data;

    if (!song?.more_info?.encrypted_media_url) return false;

    const rawMediaUrl = decryptMediaUrl(song.more_info.encrypted_media_url);
    const audioUrl = getQualityUrl(rawMediaUrl, quality);

    const title = song.title || 'Unknown Track';
    const performer = song.more_info?.artists?.primary?.map((a: any) => a.name).join(', ') || song.subtitle || 'JioSaavn';
    const albumName = song.more_info?.album || '';
    const year = song.year || '';
    const duration = parseInt(song.more_info?.duration, 10) || 0;
    const thumbUrl = song.image ? song.image.replace(/150x150|50x50/, '500x500') : undefined;

    const caption = '🤖 @saavnmusicbot';

    const reqId = crypto.randomBytes(8).toString('hex');
    tmpAudioPath = path.join(process.cwd(), `tmp_${reqId}.m4a`);
    tmpOutPath = path.join(process.cwd(), `out_${reqId}.m4a`);
    
    const audioBuffer = await axios.get(audioUrl, { responseType: 'arraybuffer' });
    fs.writeFileSync(tmpAudioPath, audioBuffer.data);

    const args = ['-y', '-i', tmpAudioPath];

    if (thumbUrl) {
      try {
        const imgBuffer = await axios.get(thumbUrl, { responseType: 'arraybuffer' });
        tmpImgPath = path.join(process.cwd(), `tmp_${reqId}.jpg`);
        fs.writeFileSync(tmpImgPath, imgBuffer.data);
        args.push('-i', tmpImgPath, '-map', '0', '-map', '1', '-c', 'copy', '-disposition:v:0', 'attached_pic');
      } catch (e) {
        console.error('Image download failed:', e);
        args.push('-c', 'copy');
      }
    } else {
      args.push('-c', 'copy');
    }

    args.push(
      '-metadata', `title=${title}`,
      '-metadata', `artist=${performer}`,
      '-metadata', `album=${albumName}`,
      '-metadata', `date=${year}`,
      tmpOutPath
    );

    await execFilePromise('ffmpeg', args);

    const inputFile = new InputFile(tmpOutPath, `${title}.m4a`);
    await ctx.replyWithAudio(inputFile, { title, performer, duration, caption, parse_mode: 'MarkdownV2' });

    return true;
  } catch (err) {
    console.error('Download error:', err);
    return false;
  } finally {
    if (tmpAudioPath && fs.existsSync(tmpAudioPath)) fs.unlinkSync(tmpAudioPath);
    if (tmpImgPath && fs.existsSync(tmpImgPath)) fs.unlinkSync(tmpImgPath);
    if (tmpOutPath && fs.existsSync(tmpOutPath)) fs.unlinkSync(tmpOutPath);
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
  let saavnQuery = query;
  const cleanQuery = query.replace(/['`‘’ʻʼ]/g, '').trim();
  const spaceQuery = query.replace(/['`‘’ʻʼ\-]/g, ' ').replace(/\s+/g, ' ').trim();

  if (type === 'song' && page === 1 && query.split(' ').length <= 4) {
    try {
      let itunes = await axios.get(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=1`).catch(() => null);
      if (!itunes?.data?.results?.length && cleanQuery !== query) {
        itunes = await axios.get(`https://itunes.apple.com/search?term=${encodeURIComponent(cleanQuery)}&entity=song&limit=1`).catch(() => null);
      }
      if (!itunes?.data?.results?.length && spaceQuery !== query && spaceQuery !== cleanQuery) {
        itunes = await axios.get(`https://itunes.apple.com/search?term=${encodeURIComponent(spaceQuery)}&entity=song&limit=1`).catch(() => null);
      }

      if (itunes && itunes.data?.results?.length > 0) {
        const item = itunes.data.results[0];
        saavnQuery = `${item.artistName} ${item.trackName}`;
      }
    } catch (e) {
      console.error('iTunes API error:', e);
    }
  }

  const url = `${BASE_API}/${type}s?q=${encodeURIComponent(saavnQuery)}&limit=50`;
  
  try {
    let results: any[] = [];

    // Smart Artist Logic: If searching for an artist and it's a short query,
    // find the top song for this artist and extract the actual artist object.
    if (type === 'artist' && page === 1 && query.split(' ').length <= 2) {
      try {
        const itunes = await axios.get(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=1`).catch(() => null);
        if (itunes && itunes.data?.results?.length > 0) {
          const item = itunes.data.results[0];
          const smartSongQuery = `${item.artistName} ${item.trackName}`;
          
          const songResp = await axios.get(`${BASE_API}/songs?q=${encodeURIComponent(smartSongQuery)}&limit=1`).catch(() => null);
          if (songResp && songResp.data?.results?.length > 0) {
            const song = songResp.data.results[0];
            const primaryArtists = [
              ...(song.more_info?.artists?.primary || []),
              ...(song.artists?.primary || [])
            ];
            
            const exactArtist = primaryArtists.find((a: any) => a.name.toLowerCase().includes(query.toLowerCase())) || primaryArtists[0];
            const token = extractArtistToken(exactArtist);
            
            if (exactArtist && token) {
              results.push({
                id: exactArtist.id,
                name: exactArtist.name,
                role: exactArtist.role || 'singer',
                image: exactArtist.image,
                type: 'artist',
                perma_url: exactArtist.perma_url,
                token: token
              });
            }
          }
        }
      } catch (e) {
        console.error('Smart Artist API error:', e);
      }
    }

    // Smart Album Logic: If searching for an album and it's a short query,
    // find top album via iTunes API, and fetch that specific album from JioSaavn.
    if (type === 'album' && page === 1 && query.split(' ').length <= 2) {
      try {
        const itunes = await axios.get(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=album&limit=1`).catch(() => null);
        if (itunes && itunes.data?.results?.length > 0) {
          const item = itunes.data.results[0];
          const smartAlbumQuery = `${item.artistName} ${item.collectionName}`;
          
          const albumResp = await axios.get(`${BASE_API}/albums?q=${encodeURIComponent(smartAlbumQuery)}&limit=1`).catch(() => null);
          if (albumResp && albumResp.data?.results?.length > 0) {
            results.push(albumResp.data.results[0]);
          }
        }
      } catch (e) {
        console.error('Smart Album API error:', e);
      }
    }

    let resp: any = await axios.get(url).catch(() => null);
    let apiResults = resp?.data?.results || [];

    // Fallback 1: Try cleanQuery (without apostrophes: "Manzilsiz yollar")
    if ((!apiResults || apiResults.length === 0) && cleanQuery !== saavnQuery) {
      resp = await axios.get(`${BASE_API}/${type}s?q=${encodeURIComponent(cleanQuery)}&limit=50`).catch(() => null);
      if (resp && resp.data?.results?.length > 0) apiResults = resp.data.results;
    }

    // Fallback 2: Try spaceQuery (apostrophes & dashes replaced with spaces: "Manzilsiz yo llar")
    if ((!apiResults || apiResults.length === 0) && spaceQuery !== saavnQuery && spaceQuery !== cleanQuery) {
      resp = await axios.get(`${BASE_API}/${type}s?q=${encodeURIComponent(spaceQuery)}&limit=50`).catch(() => null);
      if (resp && resp.data?.results?.length > 0) apiResults = resp.data.results;
    }

    // Fallback 3: If saavnQuery was augmented to artist+track, fallback to original query
    if ((!apiResults || apiResults.length === 0) && query !== saavnQuery && query !== cleanQuery && query !== spaceQuery) {
      resp = await axios.get(`${BASE_API}/${type}s?q=${encodeURIComponent(query)}&limit=50`).catch(() => null);
      if (resp && resp.data?.results?.length > 0) apiResults = resp.data.results;
    }

    results = dedupeByKeys([...results, ...apiResults]);

    const lang = getUserLanguage(ctx);

    if (!Array.isArray(results) || results.length === 0) {
      const emptyMsg = `❌ "*${escapeMd(query)}*" ${t(lang, 'notFound')}`;
      if (messageId) {
        await ctx.api.editMessageText(ctx.chat.id, messageId, emptyMsg, { parse_mode: 'MarkdownV2' });
      } else {
        await ctx.reply(emptyMsg, { parse_mode: 'MarkdownV2' });
      }
      return;
    }

    const limit = 8;
    const totalPages = Math.ceil(results.length / limit) || 1;
    const currentPage = Math.max(1, Math.min(page, totalPages));
    const startIndex = (currentPage - 1) * limit;
    const topResults = results.slice(startIndex, startIndex + limit);

    const keyboard = new InlineKeyboard();
    const typeLabel = type === 'song' ? t(lang, 'songSingle') : type === 'album' ? t(lang, 'albumSingle') : t(lang, 'artistSingle');
    let msgText = `🔍 "*${escapeMd(query)}*" ${t(lang, 'resultsFor')} \\(${typeLabel}, ${currentPage}/${totalPages}\\-${t(lang, 'page')}\\):\n\n`;

    const searchId = cacheSearch(query);

    if (type === 'song') {
      topResults.forEach((song: any, index: number) => {
        const title = song.title || 'Track';
        const artist = song.more_info?.artists?.primary?.map((a: any) => a.name).join(', ') || song.subtitle || '';
        const cacheId = cacheSong(song.perma_url || song.track_url);
        const btnText = artist ? `${artist} - ${title}` : title;
        const itemNumber = startIndex + index + 1;
        keyboard.text(`${itemNumber}. ${btnText.slice(0, 48)}`, `dl_${cacheId}`).row();
      });
    } else if (type === 'album') {
      topResults.forEach((album: any, index: number) => {
        const title = album.title || 'Album';
        const subtitle = album.subtitle || '';
        const btnText = subtitle ? `${title} - ${subtitle}` : title;
        const itemNumber = startIndex + index + 1;
        keyboard.text(`${itemNumber}. ${btnText.slice(0, 48)}`, `al_${album.token}`).row();
      });
    } else if (type === 'artist') {
      topResults.forEach((artist: any, index: number) => {
        const name = artist.name || 'Artist';
        const itemNumber = startIndex + index + 1;
        keyboard.text(`${itemNumber}. ${name.slice(0, 48)}`, `ar_${artist.token}`).row();
      });
    }

    // Row 1: Pagination
    let hasPaginationRow = false;
    if (currentPage > 1) {
      keyboard.text(t(lang, 'prev'), `sp_${searchId}_${type}_${currentPage - 1}`);
      hasPaginationRow = true;
    }
    if (currentPage < totalPages) {
      keyboard.text(t(lang, 'next'), `sp_${searchId}_${type}_${currentPage + 1}`);
      hasPaginationRow = true;
    }
    if (hasPaginationRow) {
      keyboard.row();
    }

    // Row 2: Filters (All 3 in 1 single row with 🔹 active indicator)
    keyboard
      .text(type === 'song' ? `🔹 ${t(lang, 'songs')}` : t(lang, 'songs'), `sp_${searchId}_song_1`)
      .text(type === 'album' ? `🔹 ${t(lang, 'albums')}` : t(lang, 'albums'), `sp_${searchId}_album_1`)
      .text(type === 'artist' ? `🔹 ${t(lang, 'artists')}` : t(lang, 'artists'), `sp_${searchId}_artist_1`)
      .row();

    // Row 3: Close (Very bottom row)
    keyboard.text(t(lang, 'close'), 'close_msg').row();

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
    const lang = getUserLanguage(ctx);
    const errMsg = t(lang, 'downloadErr');
    if (messageId) {
      await ctx.api.editMessageText(ctx.chat.id, messageId, errMsg, { parse_mode: 'MarkdownV2' }).catch(() => {});
    } else {
      await ctx.reply(errMsg, { parse_mode: 'MarkdownV2' }).catch(() => {});
    }
  }
}

// ── /start ────────────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  const lang = getUserLanguage(ctx);
  await ctx.reply(t(lang, 'welcome'), { parse_mode: 'MarkdownV2' });
});

// ── /language ─────────────────────────────────────────────────────────────────
bot.command(['language', 'lang'], async (ctx) => {
  const lang = getUserLanguage(ctx);
  await ctx.reply(t(lang, 'langTitle'), {
    parse_mode: 'MarkdownV2',
    reply_markup: buildLanguageKeyboard(lang),
  });
});

// ── /quality ──────────────────────────────────────────────────────────────────
bot.command('quality', async (ctx) => {
  const userId = ctx.from?.id ?? 0;
  const lang = getUserLanguage(ctx);
  const current = getUserQuality(userId);

  await ctx.reply(
    `${t(lang, 'qualityTitle')} *${escapeMd(QUALITY_LABELS[current])}*`,
    { parse_mode: 'MarkdownV2', reply_markup: buildQualityKeyboard(current, lang) }
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

  // ── Language selection ────────────────────────────────────────────────────
  if (data.startsWith('setlang_')) {
    const selected = data.replace('setlang_', '') as Language;
    if (['uz', 'ru', 'en'].includes(selected)) {
      userLanguage.set(userId, selected);
      await ctx.editMessageText(t(selected, 'langSaved'), {
        parse_mode: 'MarkdownV2',
        reply_markup: buildLanguageKeyboard(selected),
      });
      await ctx.answerCallbackQuery();
    }
    return;
  }

  // ── Search Pagination & Filter ───────────────────────────────────────────
  if (data.startsWith('sp_')) {
    const parts = data.split('_');
    const searchId = parts[1];
    const type = parts[2] as SearchType;
    const page = parseInt(parts[3], 10);
    const lang = getUserLanguage(ctx);
    
    const query = searchCache.get(searchId);
    if (!query) {
      await ctx.answerCallbackQuery({ text: t(lang, 'searchExpired') });
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
    const lang = getUserLanguage(ctx);

    if (!['96', '160', '320'].includes(selected)) {
      await ctx.answerCallbackQuery({ text: t(lang, 'invalidQuality') });
      return;
    }

    userQuality.set(userId, selected);

    await ctx.editMessageText(
      `${t(lang, 'qualitySaved')}\n\nHozirgi sifat: *${escapeMd(QUALITY_LABELS[selected])}*`,
      { parse_mode: 'MarkdownV2', reply_markup: buildQualityKeyboard(selected, lang) }
    );
    await ctx.answerCallbackQuery({ text: `✅ ${selected} kbps ${t(lang, 'qualitySelected')}` });
    return;
  }

  // ── Album Fetch ──────────────────────────────────────────────────────────
  if (data.startsWith('al_')) {
    const lang = getUserLanguage(ctx);
    const token = data.replace('al_', '');
    await ctx.answerCallbackQuery().catch(() => {});
    
    try {
      const resp = await axios.get(`${BASE_API}/album?token=${token}`);
      const album = resp.data;
      if (!album || !album.songs || album.songs.length === 0) {
        await editOrReplaceText(ctx, t(lang, 'noAlbumFound'), { parse_mode: 'MarkdownV2' });
        return;
      }
      
      const keyboard = new InlineKeyboard();
      let msgText = `💿 *${escapeMd(album.title)}*\n👤 ${escapeMd(album.subtitle || album.header_desc)}\n\n*Tracklist:*\n`;
      
      album.songs.forEach((song: any, index: number) => {
        const title = song.title || 'Track';
        const dur = formatDuration(song.more_info?.duration || song.duration);
        msgText += `${index + 1}\\. ${escapeMd(title)} \\(${dur}\\)\n`;
        const cacheId = cacheSong(song.perma_url || song.track_url);
        keyboard.text(`${index + 1}. ${title.slice(0, 48)}`, `dl_${cacheId}`).row();
      });
      
      keyboard.text(t(lang, 'downloadAll'), `dla_${token}`).row();
      keyboard.text(t(lang, 'close'), 'close_msg').row();
      
      const imgUrl = typeof album.image === 'string' && album.image.startsWith('http')
        ? album.image.replace(/150x150|50x50/, '500x500')
        : undefined;

      await ctx.deleteMessage().catch(() => {});

      if (imgUrl) {
        await ctx.replyWithPhoto(imgUrl, {
          caption: msgText,
          parse_mode: 'MarkdownV2',
          reply_markup: keyboard
        });
      } else {
        await ctx.reply(msgText, {
          parse_mode: 'MarkdownV2',
          reply_markup: keyboard
        });
      }
    } catch (err) {
      console.error('Album fetch error:', err);
      await editOrReplaceText(ctx, t(lang, 'noAlbumFound'), { parse_mode: 'MarkdownV2' });
    }
    return;
  }

  // ── Artist Fetch ─────────────────────────────────────────────────────────
  if (data.startsWith('ar_')) {
    const lang = getUserLanguage(ctx);
    const token = data.replace('ar_', '');
    await ctx.editMessageText(t(lang, 'artistLoading'), { parse_mode: 'MarkdownV2' }).catch(() => {});
    await ctx.answerCallbackQuery().catch(() => {});
    
    try {
      const resp = await axios.get(`${BASE_API}/artist?token=${token}`);
      const artist = resp.data;
      if (!artist || !artist.name) {
        await ctx.editMessageText(t(lang, 'noArtistFound'), { parse_mode: 'MarkdownV2' }).catch(() => {});
        return;
      }
      
      const keyboard = new InlineKeyboard();
      // Row 1: Left: Top 10 Tracks, Right: Albums
      keyboard
        .text('Top 10 Tracks', `artop_${token}`)
        .text('Albums', `aralb_${token}`)
        .row();
      
      // Row 2: Bottom wide Close button
      keyboard.text(t(lang, 'close'), 'close_msg').row();
      
      const imgUrl = typeof artist.image === 'string' && artist.image.startsWith('http')
        ? artist.image.replace(/150x150|50x50/, '500x500')
        : undefined;

      await ctx.deleteMessage().catch(() => {});

      if (imgUrl) {
        await ctx.replyWithPhoto(imgUrl, {
          caption: `*${escapeMd(artist.name)}*`,
          parse_mode: 'MarkdownV2',
          reply_markup: keyboard
        });
      } else {
        await ctx.reply(`👤 *${escapeMd(artist.name)}*`, {
          parse_mode: 'MarkdownV2',
          reply_markup: keyboard
        });
      }
    } catch (err) {
      console.error('Artist fetch error:', err);
      await ctx.editMessageText(t(lang, 'noArtistFound'), { parse_mode: 'MarkdownV2' }).catch(() => {});
    }
    return;
  }

  // ── Artist TOP 10 Fetch ──────────────────────────────────────────────────
  if (data.startsWith('artop_')) {
    const lang = getUserLanguage(ctx);
    const token = data.replace('artop_', '');
    await ctx.answerCallbackQuery().catch(() => {});
    
    try {
      const resp = await axios.get(`${BASE_API}/artist?token=${token}`);
      const artist = resp.data;
      if (!artist || !artist.name) {
        await editOrReplaceText(ctx, t(lang, 'noSongsFound'), { parse_mode: 'MarkdownV2' });
        return;
      }

      // Also search songs by artist name (via JioSaavn & iTunes API) to include collabs & featured tracks
      let searchSongs: any[] = [];
      if (artist && artist.name) {
        const cleanName = artist.name.replace(/['‘’`]/g, '');
        const spaceName = artist.name.replace(/['‘’`]/g, ' ');

        const queries = Array.from(new Set([artist.name, cleanName, spaceName].filter(Boolean)));
        const saavnResps = await Promise.all(
          queries.map((q) => axios.get(`${BASE_API}/songs?q=${encodeURIComponent(q)}&limit=50`).catch(() => null))
        );

        for (const r of saavnResps) {
          if (r && r.data?.results) {
            const valid = r.data.results.filter((song: any) => isItemByArtist(song, artist));
            searchSongs.push(...valid);
          }
        }

        // Query iTunes API for missing top tracks
        try {
          const itResp = await axios.get(`https://itunes.apple.com/search?term=${encodeURIComponent(artist.name)}&entity=song&limit=25`).catch(() => null);
          const itSongs = (itResp?.data?.results || []).filter((s: any) => isItemByArtist(s, artist));
          if (itSongs.length > 0) {
            const itPromises = itSongs.slice(0, 15).map((it: any) =>
              axios.get(`${BASE_API}/songs?q=${encodeURIComponent(it.trackName + ' ' + artist.name)}&limit=5`).catch(() => null)
            );
            const saavnMatchResps = await Promise.all(itPromises);
            for (const r of saavnMatchResps) {
              if (r && r.data?.results) {
                const valid = r.data.results.filter((song: any) => isItemByArtist(song, artist));
                searchSongs.push(...valid);
              }
            }
          }
        } catch (e) {}
      }

      const combinedSongs = [
        ...(artist.topSongs || []),
        ...searchSongs
      ];
      
      const keyboard = new InlineKeyboard();
      let msgText = `👤 *${escapeMd(artist.name)}*\n\n*Top 10:*\n`;
      
      const uniqueTopSongs = dedupeByKeys(combinedSongs);
      if (uniqueTopSongs.length === 0) {
        await editOrReplaceText(ctx, t(lang, 'noSongsFound'), { parse_mode: 'MarkdownV2' });
        return;
      }

      uniqueTopSongs.slice(0, 10).forEach((song: any, index: number) => {
        const title = song.title || 'Track';
        const dur = formatDuration(song.duration || song.more_info?.duration);
        msgText += `${index + 1}\\. ${escapeMd(title)} \\(${dur}\\)\n`;
        const cacheId = cacheSong(song.perma_url || song.track_url);
        keyboard.text(`${index + 1}. ${title.slice(0, 48)}`, `dl_${cacheId}`).row();
      });
      
      keyboard.text(t(lang, 'prev'), `ar_${token}`).row();
      keyboard.text(t(lang, 'close'), 'close_msg').row();
      
      await editOrReplaceText(ctx, msgText, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
    } catch (err) {
      console.error('Artist Top 10 fetch error:', err);
      await editOrReplaceText(ctx, t(lang, 'noSongsFound'), { parse_mode: 'MarkdownV2' });
    }
    return;
  }

  // ── Artist Albums Fetch ──────────────────────────────────────────────────
  if (data.startsWith('aralb_')) {
    const lang = getUserLanguage(ctx);
    const payload = data.replace('aralb_', '');
    let page = 1;
    let token = payload;

    const pageMatch = payload.match(/^(\d+)_(.+)$/);
    if (pageMatch) {
      page = parseInt(pageMatch[1], 10);
      token = pageMatch[2];
    }

    await ctx.answerCallbackQuery().catch(() => {});
    
    try {
      const resp = await axios.get(`${BASE_API}/artist?token=${token}`);
      const artist = resp.data;

      // Also search albums by artist name (via JioSaavn & iTunes API) to include collab & featured albums
      let searchAlbums: any[] = [];
      if (artist && artist.name) {
        const cleanName = artist.name.replace(/['‘’`]/g, '');
        const spaceName = artist.name.replace(/['‘’`]/g, ' ');

        const queries = Array.from(new Set([artist.name, cleanName, spaceName].filter(Boolean)));
        const saavnResps = await Promise.all(
          queries.map((q) => axios.get(`${BASE_API}/albums?q=${encodeURIComponent(q)}&limit=50`).catch(() => null))
        );

        for (const r of saavnResps) {
          if (r && r.data?.results) {
            const valid = r.data.results.filter((album: any) => isItemByArtist(album, artist));
            searchAlbums.push(...valid);
          }
        }

        // Query iTunes API for missing albums (like Ming Afsus) and match them on JioSaavn
        try {
          const itResp = await axios.get(`https://itunes.apple.com/search?term=${encodeURIComponent(artist.name)}&entity=album&limit=50`).catch(() => null);
          const itAlbums = (itResp?.data?.results || []).filter((a: any) => isItemByArtist(a, artist));
          if (itAlbums.length > 0) {
            const saavnPromises = itAlbums.map((it: any) =>
              axios.get(`${BASE_API}/albums?q=${encodeURIComponent(it.collectionName)}&limit=5`).catch(() => null)
            );
            const saavnMatchResps = await Promise.all(saavnPromises);
            for (const r of saavnMatchResps) {
              if (r && r.data?.results) {
                const valid = r.data.results.filter((album: any) => isItemByArtist(album, artist));
                searchAlbums.push(...valid);
              }
            }
          }
        } catch (e) {}
      }
      
      const allAlbums = [
        ...(artist.topAlbums || []),
        ...(artist.latest_release || []),
        ...(artist.singles || []),
        ...searchAlbums
      ];
      
      const uniqueAlbums = dedupeByKeys(allAlbums);
      
      if (!uniqueAlbums || uniqueAlbums.length === 0) {
        await editOrReplaceText(ctx, t(lang, 'noAlbumsFound'), { parse_mode: 'MarkdownV2' });
        return;
      }

      const pageSize = 10;
      const totalAlbums = uniqueAlbums.length;
      const totalPages = Math.ceil(totalAlbums / pageSize);
      const currentPage = Math.max(1, Math.min(page, totalPages));
      
      const startIndex = (currentPage - 1) * pageSize;
      const pageAlbums = uniqueAlbums.slice(startIndex, startIndex + pageSize);
      
      const keyboard = new InlineKeyboard();
      let msgText = `👤 *${escapeMd(artist.name)}* — 💿 *${t(lang, 'albumAndSingles')}* \\(${currentPage}/${totalPages}\\-${t(lang, 'page')}\\):\n\n`;
      
      pageAlbums.forEach((album: any, index: number) => {
        const title = album.title || 'Album';
        const itemNumber = startIndex + index + 1;
        keyboard.text(`${itemNumber}. ${title.slice(0, 48)}`, `al_${album.token}`).row();
      });

      // Pagination controls
      let hasPaginationRow = false;
      if (currentPage > 1) {
        keyboard.text(t(lang, 'prev'), `aralb_${currentPage - 1}_${token}`);
        hasPaginationRow = true;
      }
      if (currentPage < totalPages) {
        keyboard.text(t(lang, 'next'), `aralb_${currentPage + 1}_${token}`);
        hasPaginationRow = true;
      }
      if (hasPaginationRow) {
        keyboard.row();
      }

      // Back to Artist Profile & Close
      keyboard.text(t(lang, 'backToArtist'), `ar_${token}`).row();
      keyboard.text(t(lang, 'close'), 'close_msg').row();
      
      await editOrReplaceText(ctx, msgText, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
    } catch (err) {
      console.error('Artist Albums fetch error:', err);
      await editOrReplaceText(ctx, t(lang, 'noAlbumsFound'), { parse_mode: 'MarkdownV2' });
    }
    return;
  }

  // ── Download All (Album & Artist) ────────────────────────────────────────
  if (data.startsWith('dla_') || data.startsWith('dlar_')) {
    const isArtist = data.startsWith('dlar_');
    const token = data.replace(isArtist ? 'dlar_' : 'dla_', '');
    
    await ctx.answerCallbackQuery({ text: '⏳ Barcha musiqalar yuklanmoqda...' });
    await ctx.editMessageText('⏳ *Musiqalar tayyorlanmoqda…*', { parse_mode: 'MarkdownV2' }).catch(() => {});
    
    try {
      const url = isArtist ? `${BASE_API}/artist?token=${token}` : `${BASE_API}/album?token=${token}`;
      const resp = await axios.get(url);
      const items = isArtist ? resp.data?.topSongs : resp.data?.songs;
      
      if (!items || !Array.isArray(items) || items.length === 0) {
        await ctx.editMessageText('❌ *Musiqalar topilmadi\\.*', { parse_mode: 'MarkdownV2' }).catch(() => {});
        return;
      }
      
      const quality = getUserQuality(userId);
      let successCount = 0;
      
      for (let i = 0; i < items.length; i++) {
        await ctx.editMessageText(
          `⏳ *Yuklanmoqda: ${i + 1} / ${items.length}*`, 
          { parse_mode: 'MarkdownV2' }
        ).catch(() => {});
        
        const permaUrl = items[i].perma_url || items[i].track_url || items[i].url;
        if (permaUrl) {
          const ok = await downloadAndSendAudio(ctx, permaUrl, quality);
          if (ok) successCount++;
        }
      }
      
      await ctx.editMessageText(
        `✅ *Yakunlandi\\! ${successCount}/${items.length} ta musiqa yuklandi\\.*`, 
        { parse_mode: 'MarkdownV2' }
      ).catch(() => {});
      
    } catch (err) {
      console.error('Download All error:', err);
      await ctx.editMessageText('❌ *Kutilmagan xatolik yuz berdi\\.*', { parse_mode: 'MarkdownV2' }).catch(() => {});
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
  // ── Direct Link Handler (Spotify, Apple Music, JioSaavn) ───────────────────
  if (text.includes('spotify.com') || text.includes('apple.com') || text.includes('jiosaavn.com/song/')) {
    const statusMsg = await ctx.reply('⏳ *Musiqa tayyorlanmoqda, kuting…*', { parse_mode: 'MarkdownV2' });

    try {
      let permaUrl = '';

      if (text.includes('jiosaavn.com/song/')) {
        const resp = await axios.get(`${SONG_API}?url=${encodeURIComponent(text)}`);
        if (resp.data?.perma_url) {
          permaUrl = resp.data.perma_url;
        }
      } else {
        let fetchUrl = text;
        const spotifyMatch = text.match(/track\/([a-zA-Z0-9]+)/);
        if (spotifyMatch) {
          fetchUrl = `https://open.spotify.com/embed/track/${spotifyMatch[1]}`;
        } else if (text.includes('music.apple.com')) {
          fetchUrl = text.replace('music.apple.com', 'embed.music.apple.com');
        }

        const res = await axios.get(fetchUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
          }
        });
        const html = res.data || '';

        let songTitle = '';
        let songArtist = '';

        const ogTitleMatch = html.match(/<meta[^>]*property=["'](?:og|twitter):title["'][^>]*content=["'](.*?)["']/i) ||
                             html.match(/<meta[^>]*content=["'](.*?)["'][^>]*property=["'](?:og|twitter):title["']/i);
        if (ogTitleMatch && ogTitleMatch[1]) {
          songTitle = ogTitleMatch[1];
        } else {
          const match = html.match(/<title>(.*?)<\/title>/i);
          if (match && match[1]) songTitle = match[1];
        }

        const ogDescMatch = html.match(/<meta[^>]*property=["'](?:og|twitter):description["'][^>]*content=["'](.*?)["']/i) ||
                            html.match(/<meta[^>]*content=["'](.*?)["'][^>]*property=["'](?:og|twitter):description["']/i);
        if (ogDescMatch && ogDescMatch[1]) {
          const desc = ogDescMatch[1];
          const parts = desc.split('·').map((p: string) => p.trim());
          if (parts.length >= 3 && parts[2].toLowerCase().includes('song')) {
            songArtist = parts[0].replace(/^Listen to .*? on Spotify\.\s*/i, '').trim();
            songTitle = parts[1].trim();
          } else if (parts.length >= 2) {
            songArtist = parts[0].replace(/^Listen to .*? on Spotify\.\s*/i, '').trim();
          }
        }

        songTitle = songTitle
          .replace(/\| Spotify/gi, '')
          .replace(/on Apple Music/gi, '')
          .replace(/- song and lyrics by.*/gi, '')
          .replace(/- song by.*/gi, '')
          .trim();

        if (songTitle && !songTitle.toLowerCase().includes('spotify - home')) {
          const primaryArtist = songArtist ? songArtist.split(',')[0].trim() : '';
          const q1 = primaryArtist ? `${primaryArtist} ${songTitle}` : songTitle;
          const q2 = songTitle;

          let searchResp = await axios.get(`${BASE_API}/songs?q=${encodeURIComponent(q1)}`).catch(() => null);
          if (!searchResp?.data?.results?.length && q2 !== q1) {
            searchResp = await axios.get(`${BASE_API}/songs?q=${encodeURIComponent(q2)}`).catch(() => null);
          }

          if (searchResp && searchResp.data?.results?.length > 0) {
            permaUrl = searchResp.data.results[0].perma_url;
          }
        }
      }

      if (permaUrl) {
        const userId = ctx.from?.id ?? 0;
        const quality = getUserQuality(userId);
        const ok = await downloadAndSendAudio(ctx, permaUrl, quality);
        if (ok) {
          await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
          return;
        }
      }

      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, '❌ *Musiqa topilmadi yoki yuklab bo\'lmadi\\.*', { parse_mode: 'MarkdownV2' });
      return;
    } catch (err) {
      console.error('Direct link error:', err);
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, '❌ *Musiqani yuklashda xatolik yuz berdi\\.*', { parse_mode: 'MarkdownV2' });
      return;
    }
  }

  // ── Text Search ──────────────────────────────────────────────────────────
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
