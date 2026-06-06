const express = require('express');
const axios = require('axios');
const cors = require('cors');
const csv = require('csv-parse/sync');
require('dotenv').config();
const xml2js = require('xml2js');
const { CosmosClient } = require('@azure/cosmos');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');



const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json()); // <- adiciona essa linha

const TOKEN = process.env.TOKEN;


// Conexão com o Cosmos DB
const cosmosClient = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT,
  key: process.env.COSMOS_KEY,
});
const database = cosmosClient.database(process.env.COSMOS_DATABASE);
const usersContainer = database.container(process.env.COSMOS_CONTAINER);

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Middleware para proteger rotas
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

app.post('/auth/google', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken obrigatório' });

  try {
    let sub, email, name, picture;

    // Tenta validar como idToken primeiro, senão usa como access_token
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      ({ sub, email, name, picture } = ticket.getPayload());
    } catch {
      // É um access_token — busca os dados do usuário na API do Google
      const response = await fetch(
        `https://www.googleapis.com/oauth2/v3/userinfo`,
        { headers: { Authorization: `Bearer ${idToken}` } }
      );
      const data = await response.json();
      sub = data.sub;
      email = data.email;
      name = data.name;
      picture = data.picture;
    }

    const { resource: existingUser } = await usersContainer.item(sub, sub).read();

    let user = existingUser;
    if (!user) {
      const { resource: newUser } = await usersContainer.items.create({
        id: sub,
        googleId: sub,
        email,
        displayName: name,
        photoUrl: picture,
        createdAt: new Date().toISOString(),
      });
      user = newUser;
    }

    const appToken = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token: appToken,
      user: {
        email: user.email,
        displayName: user.displayName,
        photoUrl: user.photoUrl,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(401).json({ error: 'Token do Google inválido' });
  }
});

// Rota para buscar o perfil do usuário logado
app.get('/me', requireAuth, async (req, res) => {
  try {
    const { resource: user } = await usersContainer.item(req.user.userId, req.user.userId).read();
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    res.json({
      email: user.email,
      displayName: user.displayName,
      photoUrl: user.photoUrl,
      createdAt: user.createdAt,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar usuário' });
  }
});



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



// ── Configuração do container de biblioteca ────────────────────────────────────
const libraryContainer = database.container(process.env.COSMOS_LIBRARY_CONTAINER);

// GET /library — retorna todos os jogos da biblioteca do usuário logado
app.get('/library', requireAuth, async (req, res) => {
  try {
    const { resources } = await libraryContainer.items
      .query({
        query: 'SELECT * FROM c WHERE c.userId = @userId',
        parameters: [{ name: '@userId', value: req.user.userId }],
      })
      .fetchAll();

    res.json(resources.map(({ id, gameId, name, thumbnail, image, rating, yearpublished }) => ({
      id: gameId,
      name,
      thumbnail,
      image,
      rating,
      yearpublished,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar biblioteca' });
  }
});

// POST /library — adiciona um jogo à biblioteca
app.post('/library', requireAuth, async (req, res) => {
  const { id, name, thumbnail, image, rating, yearpublished } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id e name são obrigatórios' });

  try {
    // Verifica se já existe
    const { resources } = await libraryContainer.items
      .query({
        query: 'SELECT * FROM c WHERE c.userId = @userId AND c.gameId = @gameId',
        parameters: [
          { name: '@userId', value: req.user.userId },
          { name: '@gameId', value: id },
        ],
      })
      .fetchAll();

    if (resources.length > 0) {
      return res.status(409).json({ error: 'Jogo já está na biblioteca' });
    }

    const { resource } = await libraryContainer.items.create({
      id: `${req.user.userId}_${id}`,   // id único no Cosmos
      userId: req.user.userId,
      gameId: id,
      name,
      thumbnail: thumbnail ?? '',
      image: image ?? '',
      rating: rating ?? '',
      yearpublished: yearpublished ?? '',
      addedAt: new Date().toISOString(),
    });

    res.status(201).json({ success: true, item: resource });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao adicionar jogo' });
  }
});

// DELETE /library/:gameId — remove um jogo da biblioteca
app.delete('/library/:gameId', requireAuth, async (req, res) => {
  const { gameId } = req.params;
  const docId = `${req.user.userId}_${gameId}`;

  try {
    await libraryContainer.item(docId, req.user.userId).delete();
    res.json({ success: true });
  } catch (err) {
    if (err.code === 404) {
      return res.status(404).json({ error: 'Jogo não encontrado na biblioteca' });
    }
    console.error(err);
    res.status(500).json({ error: 'Erro ao remover jogo' });
  }
});

// GET /library/:gameId/check — verifica se um jogo está na biblioteca
app.get('/library/:gameId/check', requireAuth, async (req, res) => {
  const { gameId } = req.params;
  try {
    const { resources } = await libraryContainer.items
      .query({
        query: 'SELECT c.id FROM c WHERE c.userId = @userId AND c.gameId = @gameId',
        parameters: [
          { name: '@userId', value: req.user.userId },
          { name: '@gameId', value: gameId },
        ],
      })
      .fetchAll();

    res.json({ inLibrary: resources.length > 0 });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao verificar biblioteca' });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Servidor rodando na porta ${PORT}`);

});