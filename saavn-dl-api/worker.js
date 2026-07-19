export default {
  async fetch(request) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Content-Type": "application/json",
    };

    // HANDLE PREFLIGHT
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    try {
      const url = new URL(request.url);
      const pathname = url.pathname;

// REQUEST LOGGING

const cf = request.cf || {};

console.log(
  JSON.stringify({
    timestamp:
      new Date().toISOString(),

    path: pathname,

    method:
      request.method,

    country:
      cf.country || null,

    city:
      cf.city || null,

    colo:
      cf.colo || null,

    ip:
      request.headers.get(
        "cf-connecting-ip"
      ),

    origin:
      request.headers.get(
        "origin"
      ),

    referer:
      request.headers.get(
        "referer"
      ),

    userAgent:
      request.headers.get(
        "user-agent"
      ),
  })
);

// IMAGE PROXY

if (pathname === "/image") {
  const target = url.searchParams.get("url");

  if (!target) {
    return error(
      "Missing image URL",
      400,
      corsHeaders
    );
  }

  const response = await fetch(target, {
    cf: {
      cacheTtl: 86400,
      cacheEverything: true,
    },
  });

  if (!response.ok) {
    return error(
      "Failed to fetch image",
      500,
      corsHeaders
    );
  }

  return new Response(response.body, {
    status: response.status,
    headers: {
      ...corsHeaders,

      "Content-Type":
        response.headers.get("content-type") ||
        "image/jpeg",

      "Cache-Control":
        "public, max-age=86400",

      // IMPORTANT
      "Cross-Origin-Resource-Policy":
        "cross-origin",

      "Cross-Origin-Embedder-Policy":
        "require-corp",
    },
  });
}

// PREVIEW AUDIO PROXY

if (pathname === "/preview") {
  const target = url.searchParams.get("url");

  if (!target) {
    return error(
      "Missing preview URL",
      400,
      corsHeaders
    );
  }

  const range =
    request.headers.get("Range");

  const response = await fetch(target, {
    headers: range
      ? {
          Range: range,
        }
      : {},
  });

  if (!response.ok && response.status !== 206) {
    return error(
      "Failed to fetch preview audio",
      500,
      corsHeaders
    );
  }

  return new Response(response.body, {
    status: response.status,
    headers: {
      ...corsHeaders,

      "Content-Type":
        response.headers.get("content-type") ||
        "audio/mpeg",

      "Content-Length":
        response.headers.get("content-length") || "",

      "Accept-Ranges":
        response.headers.get("accept-ranges") || "bytes",

      "Content-Range":
        response.headers.get("content-range") || "",

      "Cache-Control":
        "public, max-age=86400",

      // IMPORTANT
      "Cross-Origin-Resource-Policy":
        "cross-origin",

      "Cross-Origin-Embedder-Policy":
        "require-corp",
    },
  });
}

      // ROOT
      if (pathname === "/") {
        return json(
          {
            github: "ODSkyler",
            status: "running",
            endpoints: {
              song: "/song?url=JIOSAAVN_SONG_URL",
              album: "/album?url=JIOSAAVN_ALBUM_URL",
            },
          },
          corsHeaders
        );
      }

      // SONG ROUTE
      if (pathname === "/song") {
        const songUrl = url.searchParams.get("url");

        if (!songUrl) {
          return error(
            "Missing 'url' query parameter",
            400,
            corsHeaders
          );
        }

        // VALIDATE URL
        if (!songUrl.includes("jiosaavn.com/song/")) {
          return error(
            "Invalid JioSaavn song URL",
            400,
            corsHeaders
          );
        }

        // EXTRACT TOKEN
        const token = extractToken(songUrl);

        if (!token) {
          return error(
            "Could not extract song token",
            400,
            corsHeaders
          );
        }

        // BUILD API URL
        const endpoint =
          "https://www.jiosaavn.com/api.php" +
          `?__call=webapi.get` +
          `&token=${encodeURIComponent(token)}` +
          `&type=song` +
          `&includeMetaTags=0` +
          `&ctx=web6dot0` +
          `&api_version=4` +
          `&_format=json` +
          `&_marker=0`;

        // FETCH FROM JIOSAAVN
        const response = await fetch(endpoint, {
          method: "GET",
          headers: buildHeaders(songUrl),
        });

        if (!response.ok) {
          return error(
            "Failed to fetch song data",
            500,
            corsHeaders
          );
        }

        const raw = await response.json();

        const song = raw?.songs?.[0];

        if (!song) {
          return error(
            "Song not found",
            404,
            corsHeaders
          );
        }

        // CLEAN RESPONSE
        const cleaned = cleanSong(song);

        return json(cleaned, corsHeaders);
      }

      // ALBUM ROUTE
      if (pathname === "/album") {
        const albumUrl =
        url.searchParams.get("url");

      if (!albumUrl) {
        return error(
        "Missing 'url' query parameter",
        400,
        corsHeaders
       );
     }

     if (
       !albumUrl.includes(
       "jiosaavn.com/album/"
        )
     ) {
     return error(
      "Invalid JioSaavn album URL",
      400,
      corsHeaders
      );
    }

    const token =
       extractToken(albumUrl);

    if (!token) {
     return error(
         "Could not extract album token",
         400,
         corsHeaders
       );
     }

     const endpoint =
       "https://www.jiosaavn.com/api.php" +
       `?__call=webapi.get` +
       `&token=${encodeURIComponent(
         token
       )}` +
       `&type=album` +
       `&includeMetaTags=0` +
       `&ctx=web6dot0` +
       `&api_version=4` +
       `&_format=json` +
       `&_marker=0`;

     const response =
       await fetch(endpoint, {
         headers:
           buildHeaders(albumUrl),
       });

     if (!response.ok) {
       return error(
         "Failed to fetch album data",
         500,
         corsHeaders
       );
     }

     const album =
       await response.json();

     return json(
       cleanAlbum(album),
       corsHeaders
     );
   }

      return error(
        "Route not found",
        404,
        corsHeaders
      );
    } catch (err) {
      return error(
        err?.message || "Internal Server Error",
        500,
        corsHeaders
      );
    }
  },
};

// ========================
// HELPERS
// ========================

function sanitizeText(text) {
  if (!text || typeof text !== "string") {
    return text;
  }

  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractToken(url) {
  try {
    const clean = url.split("?")[0];
    const parts = clean.split("/");

    return parts[parts.length - 1];
  } catch {
    return null;
  }
}

function upgradeImage(url) {
  if (!url) return null;

  return url
    .replace("50x50", "500x500")
    .replace("150x150", "500x500");
}

function buildHeaders(refererUrl) {
  return {
    accept: "application/json, text/plain, */*",

    "x-requested-with":
      "XMLHttpRequest",

    "accept-language":
      "en-US,en;q=0.9",

    referer: refererUrl,

    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",

    cookie:
      "L=english; " +
      "mm_latlong=19.0760%2C72.8777; " +
      "geo=19.0760%2C72.8777%2CIN%2CMaharashtra%2CMumbai%2C400001",
  };
}

function cleanSong(song) {
  const info = song.more_info || {};
  const artistMap = info.artistMap || {};

  return {
    id: song.id,
    token: extractToken(song.perma_url),
    title: sanitizeText(song.title),
    subtitle: sanitizeText(song.subtitle),
    type: song.type,
    perma_url: song.perma_url,
    image: upgradeImage(song.image),
    language: song.language,
    year: song.year,
    play_count: song.play_count,
    isExplicit:
      song.explicit_content === "1",
    more_info: {
      album_id: info.album_id,
      album_token: extractToken(info.album_url || ""),
      album: sanitizeText(info.album),
      label: sanitizeText(info.label),
      album_url: info.album_url,
      encrypted_media_url:
        info.encrypted_media_url,
      duration: info.duration,
      copyright_text:
        sanitizeText(info.copyright_text),
      artists: {
        primary: (
          artistMap.primary_artists || []
        ).map((artist) => ({
          id: artist.id,
          artist_token: extractToken(
            artist.perma_url || ""
          ),
          name: sanitizeText(artist.name),
          image: upgradeImage(
            artist.image
          ),
          perma_url:
            artist.perma_url,
        })),
        featured: (
          artistMap.featured_artists || []
        ).map((artist) => ({
          id: artist.id,
          artist_token: extractToken(
            artist.perma_url || ""
          ),
          name: sanitizeText(artist.name),
          image: upgradeImage(
            artist.image
          ),
          perma_url:
            artist.perma_url,
        })),
      },
      release_date:
        info.release_date,
      vcode: info.vcode,
      vlink: info.vlink,
    },
  };
}


  function cleanAlbum(album) {
  const info =
    album.more_info || {};
  const artistMap =
    info.artistMap || {};
  return {
    id: album.id,
    token: extractToken(
      album.perma_url
    ),
    title: sanitizeText(album.title),
    subtitle:
      sanitizeText(album.subtitle),
    header_desc:
      sanitizeText(album.header_desc),
    type: album.type,
    perma_url:
      album.perma_url,
    image:
      upgradeImage(
        album.image
      ),
    language:
      album.language,
    year:
      album.year,
    song_count:
      album.list_count,
    isExplicit:
      album.explicit_content ===
      "1",
    copyright:
      info.copyright_text,
    artists: {
      primary: (
        artistMap.primary_artists ||
        []
      ).map((artist) => ({
        id: artist.id,
        artist_token:
          extractToken(
            artist.perma_url || ""
          ),
        name:
          sanitizeText(artist.name),
        image:
          upgradeImage(
            artist.image
          ),
        perma_url:
          artist.perma_url,
      })),
      featured: (
        artistMap.featured_artists ||
        []
      ).map((artist) => ({
        id: artist.id,
        artist_token:
          extractToken(
            artist.perma_url || ""
          ),
        name:
          sanitizeText(artist.name),
        image:
          upgradeImage(
            artist.image
          ),
        perma_url:
          artist.perma_url,
      })),
    },
    songs: (album.list || [])
  .map(cleanSong),
  };
}


function json(data, headers) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status: 200,
      headers,
    }
  );
}

function error(message, status, headers) {
  return new Response(
    JSON.stringify(
      {
        status: "error",
        message,
      },
      null,
      2
    ),
    {
      status,
      headers,
    }
  );
}
