const axios = require('axios');
async function test() {
  const url = `https://jiosaavn-api-eight-sigma.vercel.app/api/songs?q=Zohid%20Qaydasan%20Gulim`;
  try {
    const r = await axios.get(url);
    console.log(JSON.stringify(r.data.results, null, 2));
  } catch (e) { console.error('Error:', e.message); }
}
test();
