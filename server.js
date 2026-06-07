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


// ── Configuração do container de partidas ──────────────────────────────────────
const matchesContainer = database.container(process.env.COSMOS_MATCHES_CONTAINER);

// POST /matches — salva uma partida finalizada
app.post('/matches', requireAuth, async (req, res) => {
  const { gameId, gameName, gameThumbnail, durationSeconds, result } = req.body;
  if (!gameId || !result || durationSeconds === undefined) {
    return res.status(400).json({ error: 'gameId, result e durationSeconds são obrigatórios' });
  }
  if (!['win', 'loss'].includes(result)) {
    return res.status(400).json({ error: 'result deve ser "win" ou "loss"' });
  }

  try {
    const match = {
      id: `${req.user.userId}_${Date.now()}`,
      userId: req.user.userId,
      gameId,
      gameName,
      gameThumbnail: gameThumbnail ?? '',
      durationSeconds,
      result,
      playedAt: new Date().toISOString(),
    };
    const { resource } = await matchesContainer.items.create(match);
    res.status(201).json(resource);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao salvar partida' });
  }
});

// GET /matches — retorna todas as partidas do usuário
app.get('/matches', requireAuth, async (req, res) => {
  try {
    const { resources } = await matchesContainer.items
      .query({
        query: 'SELECT * FROM c WHERE c.userId = @userId ORDER BY c.playedAt DESC',
        parameters: [{ name: '@userId', value: req.user.userId }],
      })
      .fetchAll();
    res.json(resources);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar partidas' });
  }
});

// GET /matches/month — partidas do mês atual
app.get('/matches/month', requireAuth, async (req, res) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  try {
    const { resources } = await matchesContainer.items
      .query({
        query: 'SELECT * FROM c WHERE c.userId = @userId AND c.playedAt >= @start ORDER BY c.playedAt DESC',
        parameters: [
          { name: '@userId', value: req.user.userId },
          { name: '@start', value: startOfMonth },
        ],
      })
      .fetchAll();
    res.json(resources);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar partidas do mês' });
  }
});

// ── Configuração do container de amizades ──────────────────────────────────────
const friendshipsContainer = database.container(process.env.COSMOS_FRIENDSHIPS_CONTAINER);

// POST /friends/request — envia solicitação por email
app.post('/friends/request', requireAuth, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email obrigatório' });
  if (email === req.user.email) return res.status(400).json({ error: 'Você não pode adicionar a si mesmo' });

  try {
    // Busca o usuário alvo pelo email
    const { resources: targets } = await usersContainer.items
      .query({
        query: 'SELECT * FROM c WHERE c.email = @email',
        parameters: [{ name: '@email', value: email }],
      })
      .fetchAll();

    if (targets.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });
    const target = targets[0];

    // Verifica se já existe solicitação ou amizade
    const { resources: existing } = await friendshipsContainer.items
      .query({
        query: `SELECT * FROM c WHERE 
          (c.fromUserId = @me AND c.toUserId = @them) OR 
          (c.fromUserId = @them AND c.toUserId = @me)`,
        parameters: [
          { name: '@me', value: req.user.userId },
          { name: '@them', value: target.id },
        ],
      })
      .fetchAll();

    if (existing.length > 0) {
      const status = existing[0].status;
      if (status === 'accepted') return res.status(409).json({ error: 'Já são amigos' });
      if (status === 'pending') return res.status(409).json({ error: 'Solicitação já enviada' });
    }

    const { resource } = await friendshipsContainer.items.create({
      id: `${req.user.userId}_${target.id}`,
      userId: req.user.userId, // partition key
      fromUserId: req.user.userId,
      fromEmail: req.user.email,
      toUserId: target.id,
      toEmail: target.email,
      toDisplayName: target.displayName,
      toPhotoUrl: target.photoUrl,
      fromDisplayName: '',
      fromPhotoUrl: '',
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    // Cria também o lado do destinatário para facilitar queries
    await friendshipsContainer.items.create({
      id: `${target.id}_${req.user.userId}`,
      userId: target.id,
      fromUserId: req.user.userId,
      fromEmail: req.user.email,
      toUserId: target.id,
      toEmail: target.email,
      toDisplayName: target.displayName,
      toPhotoUrl: target.photoUrl,
      fromDisplayName: '',
      fromPhotoUrl: '',
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    res.status(201).json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao enviar solicitação' });
  }
});

// GET /friends/requests — solicitações pendentes recebidas
app.get('/friends/requests', requireAuth, async (req, res) => {
  try {
    const { resources } = await friendshipsContainer.items
      .query({
        query: `SELECT * FROM c WHERE c.userId = @me AND c.toUserId = @me AND c.status = 'pending'`,
        parameters: [{ name: '@me', value: req.user.userId }],
      })
      .fetchAll();

    // Busca displayName/photo do remetente
    const enriched = await Promise.all(resources.map(async (r) => {
      try {
        const { resource: sender } = await usersContainer.item(r.fromUserId, r.fromUserId).read();
        return {
          ...r,
          fromDisplayName: sender?.displayName ?? r.fromEmail,
          fromPhotoUrl: sender?.photoUrl ?? '',
        };
      } catch {
        return { ...r, fromDisplayName: r.fromEmail, fromPhotoUrl: '' };
      }
    }));

    res.json(enriched);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar solicitações' });
  }
});

// POST /friends/accept/:fromUserId — aceita solicitação
app.post('/friends/accept/:fromUserId', requireAuth, async (req, res) => {
  const { fromUserId } = req.params;
  try {
    // Atualiza lado do destinatário
    const docId1 = `${req.user.userId}_${fromUserId}`;
    const { resource: doc1 } = await friendshipsContainer.item(docId1, req.user.userId).read();
    if (!doc1) return res.status(404).json({ error: 'Solicitação não encontrada' });
    await friendshipsContainer.item(docId1, req.user.userId).replace({ ...doc1, status: 'accepted' });

    // Atualiza lado do remetente
    const docId2 = `${fromUserId}_${req.user.userId}`;
    try {
      const { resource: doc2 } = await friendshipsContainer.item(docId2, fromUserId).read();
      if (doc2) await friendshipsContainer.item(docId2, fromUserId).replace({ ...doc2, status: 'accepted' });
    } catch {}

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao aceitar solicitação' });
  }
});

// POST /friends/decline/:fromUserId — recusa solicitação
app.post('/friends/decline/:fromUserId', requireAuth, async (req, res) => {
  const { fromUserId } = req.params;
  try {
    const docId1 = `${req.user.userId}_${fromUserId}`;
    await friendshipsContainer.item(docId1, req.user.userId).delete();
    try {
      const docId2 = `${fromUserId}_${req.user.userId}`;
      await friendshipsContainer.item(docId2, fromUserId).delete();
    } catch {}
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao recusar solicitação' });
  }
});

// GET /friends — lista amigos aceitos
app.get('/friends', requireAuth, async (req, res) => {
  try {
    const { resources } = await friendshipsContainer.items
      .query({
        query: `SELECT * FROM c WHERE c.userId = @me AND c.status = 'accepted'`,
        parameters: [{ name: '@me', value: req.user.userId }],
      })
      .fetchAll();

    const friends = await Promise.all(resources.map(async (r) => {
      const friendId = r.fromUserId === req.user.userId ? r.toUserId : r.fromUserId;
      try {
        const { resource: friend } = await usersContainer.item(friendId, friendId).read();
        return {
          id: friendId,
          displayName: friend?.displayName ?? friendId,
          email: friend?.email ?? '',
          photoUrl: friend?.photoUrl ?? '',
        };
      } catch {
        return { id: friendId, displayName: friendId, email: '', photoUrl: '' };
      }
    }));

    res.json(friends);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar amigos' });
  }
});

// DELETE /friends/:friendId — remove amigo
app.delete('/friends/:friendId', requireAuth, async (req, res) => {
  const { friendId } = req.params;
  try {
    try { await friendshipsContainer.item(`${req.user.userId}_${friendId}`, req.user.userId).delete(); } catch {}
    try { await friendshipsContainer.item(`${friendId}_${req.user.userId}`, friendId).delete(); } catch {}
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover amigo' });
  }
});

// GET /friends/:friendId/library — biblioteca do amigo
app.get('/friends/:friendId/library', requireAuth, async (req, res) => {
  const { friendId } = req.params;
  try {
    // Verifica se são amigos
    const { resources } = await friendshipsContainer.items
      .query({
        query: `SELECT * FROM c WHERE c.userId = @me AND c.status = 'accepted' AND (c.toUserId = @friend OR c.fromUserId = @friend)`,
        parameters: [
          { name: '@me', value: req.user.userId },
          { name: '@friend', value: friendId },
        ],
      })
      .fetchAll();
    if (resources.length === 0) return res.status(403).json({ error: 'Não são amigos' });

    const { resources: games } = await libraryContainer.items
      .query({
        query: 'SELECT * FROM c WHERE c.userId = @userId',
        parameters: [{ name: '@userId', value: friendId }],
      })
      .fetchAll();

    res.json(games.map(({ gameId, name, thumbnail, image, rating, yearpublished }) => ({
      id: gameId, name, thumbnail, image, rating, yearpublished,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar biblioteca do amigo' });
  }
});

// GET /friends/:friendId/stats — estatísticas do amigo
app.get('/friends/:friendId/stats', requireAuth, async (req, res) => {
  const { friendId } = req.params;
  try {
    const { resources: friendship } = await friendshipsContainer.items
      .query({
        query: `SELECT * FROM c WHERE c.userId = @me AND c.status = 'accepted' AND (c.toUserId = @friend OR c.fromUserId = @friend)`,
        parameters: [
          { name: '@me', value: req.user.userId },
          { name: '@friend', value: friendId },
        ],
      })
      .fetchAll();
    if (friendship.length === 0) return res.status(403).json({ error: 'Não são amigos' });

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const { resources: matches } = await matchesContainer.items
      .query({
        query: 'SELECT * FROM c WHERE c.userId = @userId AND c.playedAt >= @start',
        parameters: [
          { name: '@userId', value: friendId },
          { name: '@start', value: startOfMonth },
        ],
      })
      .fetchAll();

    res.json(matches);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar stats do amigo' });
  }
});
// ── Recomendações personalizadas ───────────────────────────────────────────────

// ── Recomendações personalizadas ───────────────────────────────────────────────

app.get('/recommendations', requireAuth, async (req, res) => {
  try {
    // 1. Busca jogos mais jogados nas partidas
    const { resources: matches } = await matchesContainer.items
      .query({
        query: 'SELECT * FROM c WHERE c.userId = @userId',
        parameters: [{ name: '@userId', value: req.user.userId }],
      })
      .fetchAll();

    const playCount = {};
    for (const m of matches) {
      playCount[m.gameId] = (playCount[m.gameId] || 0) + 1;
    }
    const topPlayed = Object.entries(playCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id]) => id);

    // 2. Busca jogos da biblioteca
    const { resources: libraryGames } = await libraryContainer.items
      .query({
        query: 'SELECT * FROM c WHERE c.userId = @userId',
        parameters: [{ name: '@userId', value: req.user.userId }],
      })
      .fetchAll();
    const topLibrary = libraryGames.slice(0, 3).map(g => g.gameId);

    const userGameIds = new Set([
      ...libraryGames.map(g => g.gameId),
      ...Object.keys(playCount),
    ]);

    // 3. Busca detalhes de um jogo e extrai categorias/mecânicas
    const fetchGameDetails = async (gameId) => {
      let attempts = 0;
      let response;
      do {
        response = await axios.get(
          `https://boardgamegeek.com/xmlapi2/thing?id=${gameId}&stats=1`,
          { headers: { Authorization: `Bearer ${TOKEN}` } }
        );
        if (response.status === 202) {
          attempts++;
          await new Promise(r => setTimeout(r, 2000));
        }
      } while (response.status === 202 && attempts < 5);

      const text = response.data;
      if (typeof text !== 'string' || !text.trim().startsWith('<')) return null;

      const parsed = await xml2js.parseStringPromise(text);
      const item = parsed?.items?.item?.[0];
      if (!item) return null;

      const name = item.name?.[0]?.$.value ?? '';
      const categories = (item.link || [])
        .filter(l => l.$.type === 'boardgamecategory')
        .map(l => l.$.value)
        .slice(0, 2);
      const mechanics = (item.link || [])
        .filter(l => l.$.type === 'boardgamemechanic')
        .map(l => l.$.value)
        .slice(0, 2);

      return { id: gameId, name, categories, mechanics };
    };

    // 4. Busca jogos por categoria/mecânica e retorna os melhores
    const fetchByCategory = async (category) => {
      try {
        let attempts = 0;
        let response;
        do {
          response = await axios.get(
            `https://boardgamegeek.com/xmlapi2/search?query=${encodeURIComponent(category)}&type=boardgame&exact=0`,
            { headers: { Authorization: `Bearer ${TOKEN}` } }
          );
          if (response.status === 202) {
            attempts++;
            await new Promise(r => setTimeout(r, 2000));
          }
        } while (response.status === 202 && attempts < 3);

        const text = response.data;
        if (typeof text !== 'string' || !text.trim().startsWith('<')) return [];

        const parsed = await xml2js.parseStringPromise(text);
        const items = parsed?.items?.item || [];

        // Pega até 10 IDs que o usuário não tem
        const ids = items
          .map(i => i.$.id)
          .filter(id => !userGameIds.has(id))
          .slice(0, 10);

        if (ids.length === 0) return [];

        // Busca detalhes em batch
        let detailAttempts = 0;
        let detailResp;
        do {
          detailResp = await axios.get(
            `https://boardgamegeek.com/xmlapi2/thing?id=${ids.join(',')}&stats=1`,
            { headers: { Authorization: `Bearer ${TOKEN}` } }
          );
          if (detailResp.status === 202) {
            detailAttempts++;
            await new Promise(r => setTimeout(r, 2000));
          }
        } while (detailResp.status === 202 && detailAttempts < 5);

        const detailText = detailResp.data;
        if (typeof detailText !== 'string' || !detailText.trim().startsWith('<')) return [];

        const detailParsed = await xml2js.parseStringPromise(detailText);
        const detailItems = detailParsed?.items?.item || [];

        return detailItems
          .filter(i => i.thumbnail?.[0])
          .map(i => ({
            id: i.$.id,
            name: i.name?.[0]?.$.value ?? '',
            thumbnail: i.thumbnail?.[0] ?? '',
            rating: parseFloat(
              i.statistics?.[0]?.ratings?.[0]?.average?.[0]?.$.value ?? 0
            ).toFixed(1),
            yearpublished: i.yearpublished?.[0]?.$.value ?? '',
          }))
          .filter(g => parseFloat(g.rating) >= 6.5) // só jogos bem avaliados
          .sort((a, b) => parseFloat(b.rating) - parseFloat(a.rating))
          .slice(0, 6);
      } catch (err) {
        console.error('Erro ao buscar por categoria:', category, err.message);
        return [];
      }
    };

    // 5. Para cada jogo fonte, extrai categoria e busca similares
    const fetchSimilar = async (gameId) => {
      try {
        const details = await fetchGameDetails(gameId);
        if (!details) return { sourceId: gameId, sourceName: '', games: [] };

        const { name: sourceName, categories, mechanics } = details;
        console.log(`Jogo ${gameId} (${sourceName}) - categorias:`, categories, '- mecânicas:', mechanics);

        // Usa a primeira categoria ou mecânica disponível
        const searchTerm = categories[0] || mechanics[0];
        if (!searchTerm) return { sourceId: gameId, sourceName, games: [] };

        await new Promise(r => setTimeout(r, 500));
        const games = await fetchByCategory(searchTerm);
        const filtered = games.filter(g => g.id !== gameId && !userGameIds.has(g.id));

        console.log(`Recomendações para ${sourceName} (${searchTerm}):`, filtered.length);
        return { sourceId: gameId, sourceName, searchTerm, games: filtered };
      } catch (err) {
        console.error(`Erro ao buscar similares para ${gameId}:`, err.message);
        return { sourceId: gameId, sourceName: '', games: [] };
      }
    };

    // Executa em sequência
    const playedRecs = [];
    for (const id of topPlayed) {
      const rec = await fetchSimilar(id);
      playedRecs.push(rec);
      await new Promise(r => setTimeout(r, 1000));
    }

    const libraryRecs = [];
    for (const id of topLibrary) {
      if (topPlayed.includes(id)) continue;
      const rec = await fetchSimilar(id);
      libraryRecs.push(rec);
      await new Promise(r => setTimeout(r, 1000));
    }

    const filterRecs = (recs) => recs
      .filter(r => r.games.length > 0)
      .map(r => ({
        sourceId: r.sourceId,
        sourceName: r.sourceName,
        searchTerm: r.searchTerm,
        games: r.games.filter(g => !userGameIds.has(g.id)),
      }))
      .filter(r => r.games.length > 0);

    const result = {
      fromMatches: filterRecs(playedRecs),
      fromLibrary: filterRecs(libraryRecs),
    };

    console.log('fromMatches final:', result.fromMatches.length, 'grupos');
    console.log('fromLibrary final:', result.fromLibrary.length, 'grupos');

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar recomendações' });
  }
});


// ── Lojas de jogos de tabuleiro próximas (OpenStreetMap + Overpass) ────────────

// ── Lojas de jogos de tabuleiro próximas (OpenStreetMap + Overpass) ────────────

const OVERPASS_SERVERS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

app.get('/shop/nearby', async (req, res) => {
  const { lat, lng, radius = 10000 } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat e lng obrigatórios' });

  const overpassQuery = `[out:json][timeout:25];(node["shop"="games"](around:${radius},${lat},${lng});node["shop"="toy"](around:${radius},${lat},${lng});node["shop"="hobby"](around:${radius},${lat},${lng});way["shop"="games"](around:${radius},${lat},${lng});way["shop"="toy"](around:${radius},${lat},${lng});way["shop"="hobby"](around:${radius},${lat},${lng}););out center;`;

  let lastError = null;

  for (const server of OVERPASS_SERVERS) {
    try {
      console.log('Tentando servidor Overpass:', server);
      const response = await axios.post(
        server,
        new URLSearchParams({ data: overpassQuery }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'HexaTracker/1.0 (board game shop finder)',
            'Accept': 'application/json',
          },
          timeout: 30000,
        }
      );

      const elements = response.data.elements || [];

      const shops = elements.map(el => {
        const tags = el.tags || {};
        const elLat = el.lat ?? el.center?.lat;
        const elLng = el.lon ?? el.center?.lon;

        const R = 6371000;
        const dLat = (elLat - parseFloat(lat)) * Math.PI / 180;
        const dLng = (elLng - parseFloat(lng)) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 +
                  Math.cos(parseFloat(lat)*Math.PI/180) *
                  Math.cos(elLat*Math.PI/180) *
                  Math.sin(dLng/2)**2;
        const distance = Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));

        return {
          id: el.id,
          name: tags.name || 'Loja sem nome',
          lat: elLat,
          lng: elLng,
          distance,
          address: [tags['addr:street'], tags['addr:housenumber'], tags['addr:city']]
            .filter(Boolean).join(', ') || null,
          phone: tags.phone || tags['contact:phone'] || null,
          website: tags.website || tags['contact:website'] || null,
          opening_hours: tags.opening_hours || null,
          type: tags.shop,
        };
      })
      .filter(s => s.lat && s.lng)
      .sort((a, b) => a.distance - b.distance);

      console.log(`Lojas encontradas: ${shops.length} via ${server}`);
      return res.json(shops);

    } catch (err) {
      console.warn(`Servidor ${server} falhou:`, err.response?.status, err.message);
      lastError = err;
      continue;
    }
  }

  console.error('Todos os servidores Overpass falharam');
  res.status(500).json({ error: 'Serviço temporariamente indisponível. Tente novamente em alguns minutos.' });
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Servidor rodando na porta ${PORT}`);

});