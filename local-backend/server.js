import express from 'express';
import songsHandler from '../jiosaavn-api/api/songs.js';
import albumsHandler from '../jiosaavn-api/api/albums.js';
import artistsHandler from '../jiosaavn-api/api/artists.js';
import playlistsHandler from '../jiosaavn-api/api/playlists.js';
import songHandler from '../jiosaavn-api/api/song.js';
import albumHandler from '../jiosaavn-api/api/album.js';
import artistHandler from '../jiosaavn-api/api/artist.js';
import playlistHandler from '../jiosaavn-api/api/playlist.js';
import relatedHandler from '../jiosaavn-api/api/related.js';
import homeHandler from '../jiosaavn-api/api/home.js';
import newHandler from '../jiosaavn-api/api/new.js';
import imageHandler from '../jiosaavn-api/api/image.js';
import worker from '../saavn-dl-api/worker.js';

const app = express();
const PORT = process.env.PORT || 3000;

// CORS Preflight middleware for the entire app
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// Mount jiosaavn-api routes
app.get('/api/songs', songsHandler);
app.get('/api/albums', albumsHandler);
app.get('/api/artists', artistsHandler);
app.get('/api/playlists', playlistsHandler);
app.get('/api/song', songHandler);
app.get('/api/album', albumHandler);
app.get('/api/artist', artistHandler);
app.get('/api/playlist', playlistHandler);
app.get('/api/related', relatedHandler);
app.get('/api/home', homeHandler);
app.get('/api/new', newHandler);
app.get('/api/image', imageHandler);

// Route all other requests to the saavn-dl-api worker
app.use(async (req, res, next) => {
  try {
    const protocol = req.protocol;
    const host = req.get('host');
    const fullUrl = `${protocol}://${host}${req.originalUrl}`;

    // Construct headers
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) {
        if (Array.isArray(value)) {
          value.forEach(v => headers.append(key, v));
        } else {
          headers.set(key, value);
        }
      }
    }

    const webReq = new Request(fullUrl, {
      method: req.method,
      headers: headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
    });

    const webRes = await worker.fetch(webReq);

    res.status(webRes.status);
    webRes.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    const arrayBuffer = await webRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    res.send(buffer);
  } catch (error) {
    console.error('Unified Local Backend Worker Error:', error);
    res.status(500).json({ error: 'Worker execution failed', message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`🎵 Unified JioSaavn Local Backend is running!`);
  console.log(`🔗 API Base: http://localhost:${PORT}`);
  console.log(`==================================================`);
});
