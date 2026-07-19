import type { AlbumSearchResult, AlbumDetail } from '../types/saavn';

const SEARCH_API = import.meta.env.VITE_SEARCH_API 
  ? `${import.meta.env.VITE_SEARCH_API}/api/albums`
  : 'https://rtmx.vercel.app/api/albums';

const DETAIL_API = import.meta.env.VITE_SONG_API 
  ? `${import.meta.env.VITE_SONG_API}/album`
  : 'https://sda.rhythmax.workers.dev/album';
  // Defalut API (sda.rhythmax.workers.dev). Replace with your saavn-dl-api instance.
  // Visit https://github.com/ODSkyler/saavn-dl-api for more information.

export async function searchAlbums(query: string): Promise<AlbumSearchResult[]> {
  if (!query.trim()) return [];
  const res = await fetch(`${SEARCH_API}?q=${encodeURIComponent(query.trim())}`);
  if (!res.ok) throw new Error(`Album search failed: HTTP ${res.status}`);
  const data = await res.json();
  // normalise — API returns { total, start, results: [...] }
  const arr: AlbumSearchResult[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.results)
    ? data.results
    : [];
  return arr.filter((r) => r.type === 'album' || r.id);
}

export async function fetchAlbumDetail(albumUrl: string): Promise<AlbumDetail> {
  const res = await fetch(`${DETAIL_API}?url=${encodeURIComponent(albumUrl)}`);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(txt || `Album fetch failed: HTTP ${res.status}`);
  }
  const data: AlbumDetail = await res.json();
  if (!data?.id || !Array.isArray(data?.songs)) {
    throw new Error('Invalid album response — missing id or songs');
  }
  return data;
}
