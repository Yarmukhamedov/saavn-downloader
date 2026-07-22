const axios = require('axios');
async function test() {
  const url = `https://jiosaavn-api-eight-sigma.vercel.app/api/songs?q=Zohid%20Qaydasan%20Gulim`;
  try {
    const r = await axios.get(url);
    const topSong = r.data.results[0];
    console.log(JSON.stringify(topSong.more_info.artists, null, 2));
  } catch (e) { console.error('Songs search error'); }
}
test();
