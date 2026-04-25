const express = require('express');
const axios = require('axios');
const cors = require('cors');
const csv = require('csv-parse/sync');
require('dotenv').config();
const xml2js = require('xml2js');

const app = express();
app.use(cors({ origin: '*' }));

const TOKEN = process.env.TOKEN;

app.get('/api/bgg/search', async (req, res) => {
  const { query } = req.query;
  if (!query) return res.json([]);

  try {
    const response = await axios.get(
      `https://boardgamegeek.com/xmlapi2/search?query=${encodeURIComponent(query)}&type=boardgame`,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );
    const result = await xml2js.parseStringPromise(response.data);
    
    const items = (result.items.item || []).slice(0, 24);

    const fetchGame = async (id) => {
      try {
        let response;
        let attempts = 0;
        do {
          response = await axios.get(
            `https://boardgamegeek.com/xmlapi2/thing?id=${id}`,
            { headers: { Authorization: `Bearer ${TOKEN}` } }
          );
          if (response.status === 202) {
            attempts++;
            await new Promise(r => setTimeout(r, 2000));
          }
        } while (response.status === 202 && attempts < 5);

        const parsed = await xml2js.parseStringPromise(response.data);
        
        const item = parsed.items.item[0];
        if (!item || !item.thumbnail?.[0]) return null;
        return {
          id: item.$.id,
          name: item.name[0].$.value,
          thumbnail: item.thumbnail[0],
        };
      } catch {
        return null;
      }
    };

    const ids = items.map(i => i.$.id);
    const batchSize = 5;
    let allGames = [];
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(fetchGame));
      allGames = [...allGames, ...results.filter(g => g !== null)];
      if (i + batchSize < ids.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    res.json(allGames);
  } catch (err) {
    console.error('Erro detalhado:', err.message);
    res.status(500).json({ error: err.message });
  }
});


app.get('/api/bgg/thing/:id', async (req, res) => {
  const { id } = req.params;

  try {
    let response;
    let attempts = 0;

    do {
      response = await axios.get(
        `https://boardgamegeek.com/xmlapi2/thing?id=${id}`,
        { headers: { Authorization: `Bearer ${TOKEN}` } }
      );
      if (response.status === 202) {
        attempts++;
        await new Promise(r => setTimeout(r, 2000));
      }
    } while (response.status === 202 && attempts < 5);

    const result = await xml2js.parseStringPromise(response.data);
    const item = result.items.item[0];

    // Retorna só o que você precisa
    res.json({
      id: item.$.id,
      name: item.name[0].$.value,
      image: item.image[0],
      thumbnail: item.thumbnail[0],
    });

  } catch (err) {
    console.error('Erro detalhado:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bgg/image', async (req, res) => {
  const { url } = req.query;
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const contentType = response.headers['content-type'];
    res.setHeader('Content-Type', contentType);
    res.send(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.get('/ping', (req, res) => res.send('ok'));

let hotCache = null;


app.get('/api/bgg/hot', async (req, res) => {
  if (hotCache) {
    console.log('Retornando do cache');
    return res.json(hotCache);
  }

  try {
    const hotResponse = await axios.get(
      'https://boardgamegeek.com/xmlapi2/hot?type=boardgame',
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );
    const hotResult = await xml2js.parseStringPromise(hotResponse.data);

    const allGames = hotResult.items.item.map(item => ({
      id: item.$.id,
      rank: item.$.rank,
      name: item.name[0].$.value,
      thumbnail:  item.thumbnail[0].$.value,
    }));
    console.log('Thumbnail exemplo:', allGames[0].thumbnail);

    hotCache = allGames;
    console.log('Cache salvo com', allGames.length, 'jogos');
    res.json(allGames);
  } catch (err) {
    console.error('Erro detalhado:', err.message);
    res.status(500).json({ error: err.message });
  }
});



app.get('/api/bgg/batch', async (req, res) => {
  const { ids } = req.query;
  if (!ids) return res.json([]);

  try {
    let response;
    let attempts = 0;
    do {
      response = await axios.get(
        `https://boardgamegeek.com/xmlapi2/thing?id=${ids}`,
        { headers: { Authorization: `Bearer ${TOKEN}` } }
      );
      if (response.status === 202) {
        attempts++;
        await new Promise(r => setTimeout(r, 2000));
      }
    } while (response.status === 202 && attempts < 5);

    const result = await xml2js.parseStringPromise(response.data);
    const games = result.items.item.map(item => ({
      id: item.$.id,
      name: item.name[0].$.value,
      image: item.image[0],
      thumbnail: item.thumbnail[0],
    }));

    res.json(games);
  } catch (err) {
    console.error('Erro detalhado:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/imagem', async (req, res) => {
  try {
    const url = req.query.url;
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    res.set('Content-Type', response.headers['content-type']);
    res.send(response.data);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get('/game', async (req, res) => {
  try {
    const response = await axios.get(
      'http://boardgamegeek.com/xmlapi2/thing?type=boardgame',
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );
    res.send(response.data);
  } catch (error) {
    console.log('Erro:', error.response?.status, JSON.stringify(error.response?.data));
    res.status(500).send(error.message);
  }
});


app.get('/api/bgg/test', async (req, res) => {
  try {
    const response = await axios.get(
      'https://boardgamegeek.com/xmlapi2/thing?from=2024-01-01&to=2024-12-31',
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );
    res.send(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bgg/details/:id', async (req, res) => {
  const { id } = req.params;
  try {
    let response;
    let attempts = 0;
    do {
      response = await axios.get(
        `https://boardgamegeek.com/xmlapi2/thing?id=${id}&stats=1`,
        { headers: { Authorization: `Bearer ${TOKEN}` } }
      );
      if (response.status === 202) {
        attempts++;
        await new Promise(r => setTimeout(r, 2000));
      }
    } while (response.status === 202 && attempts < 5);

    const result = await xml2js.parseStringPromise(response.data);
    const item = result.items.item[0];
    const stats = item.statistics?.[0]?.ratings?.[0];

    res.json({
      id: item.$.id,
      name: item.name[0].$.value,
      yearpublished: item.yearpublished?.[0]?.$.value ?? 'N/A',
      image: item.image?.[0] ?? '',
      thumbnail: item.thumbnail?.[0] ?? '',
      description: item.description?.[0] ?? '',
      minplayers: item.minplayers?.[0]?.$.value ?? 'N/A',
      maxplayers: item.maxplayers?.[0]?.$.value ?? 'N/A',
      minplaytime: item.minplaytime?.[0]?.$.value ?? 'N/A',
      maxplaytime: item.maxplaytime?.[0]?.$.value ?? 'N/A',
      minage: item.minage?.[0]?.$.value ?? 'N/A',
      rating: parseFloat(stats?.average?.[0]?.$.value ?? 0).toFixed(1),
      weight: parseFloat(stats?.averageweight?.[0]?.$.value ?? 0).toFixed(2),
      rank: stats?.ranks?.[0]?.rank?.[0]?.$.value ?? 'N/A',
    });
  } catch (err) {
    console.error('Erro detalhado:', err.message);
    res.status(500).json({ error: err.message });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Servidor rodando na porta ${PORT}`);

});