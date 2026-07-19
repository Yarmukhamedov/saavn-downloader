# JioSaavn Music Downloader
Ushbu repozitoriyada JioSaavn musiqalarini yuklab beradigan loyihaning barcha komponentlari jamlangan. 

> [!NOTE]
> Bu loyiha boshqa bir original loyihalarning shaxsiy ehtiyojim uchun o'zimga moslashtirilgan variantidir.

## Loyiha Strukturasi

Loyiha quyidagi papkalardan tashkil topgan:

*   📂 **[saavn-dl](file:///Users/sss/Documents/Developer/Vibecoding/Music%20Downloader/saavn-dl)**: React, Vite va TypeScript yordamida yozilgan foydalanuvchi interfeysi (Frontend).
*   📂 **[jiosaavn-api](file:///Users/sss/Documents/Developer/Vibecoding/Music%20Downloader/jiosaavn-api)**: JioSaavn musiqalarini qidirish uchun API xizmati.
*   📂 **[saavn-dl-api](file:///Users/sss/Documents/Developer/Vibecoding/Music%20Downloader/saavn-dl-api)**: Musiqa metadatalarini yuklash va uning ichiga album art tikib berish uchun proksi Cloudflare Worker.
*   📂 **[local-backend](file:///Users/sss/Documents/Developer/Vibecoding/Music%20Downloader/local-backend)**: Lokal muhitda barcha API'larni yagona portda (`3000`) ishga tushirish uchun yozilgan Express server.

---

## Local ishga tushirish

Lokal rivojlantirish va tekshirish uchun:

1. **Backend serverni ishga tushiring**:
   ```bash
   cd local-backend
   npm install
   npm start
   ```
2. **Frontend saytni ishga tushiring**:
   ```bash
   cd saavn-dl
   npm install
   npm run dev
   ```
   *Sayt brauzerda http://localhost:5173/ manzilida ochiladi.*

---

## Bulutga yuklash (Deploy qilish)

### 1. Cloudflare Workers
`saavn-dl-api` papkasiga kiring va wrangler orqali yuklang:
```bash
cd saavn-dl-api
npx wrangler login
npm run deploy
```

### 2. Vercel (jiosaavn-api)
*   Vercel dashboard-ga kiring va ushbu monorepo loyihasini tanlang.
*   Sozlamalarda **Root Directory** qismiga `jiosaavn-api` deb yozing.
*   **Functions** bo'limida regionni **Mumbai, India (bom1)** deb sozlang.
*   Deploy qiling.

### 3. Vercel (saavn-dl)
*   Vercel-da yana bir bor ushbu repozitoriyani import qiling.
*   Sozlamalarda **Root Directory** qismiga `saavn-dl` deb yozing.
*   **Environment Variables** bo'limiga API linklarini kiriting (`VITE_SONG_API` va `VITE_SEARCH_API`).
*   Deploy qiling.
