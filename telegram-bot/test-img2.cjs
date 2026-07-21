const axios = require('axios');
async function test() {
  const resp = await axios.get('https://jiosaavn-api-eight-sigma.vercel.app/api/songs?q=blinding%20lights');
  const imgUrl = resp.data.results[0].image;
  console.log('Original image URL:', imgUrl);
  
  const sizes = ['150x150', '500x500', '1000x1000', '1500x1500'];
  for (const size of sizes) {
    const testUrl = imgUrl.replace(/150x150|50x50/, size);
    try {
      const r = await axios.head(testUrl);
      console.log(`${size} exists:`, r.status);
    } catch (e) {
      console.log(`${size} exists: false`, e.response?.status);
    }
  }
}
test();
