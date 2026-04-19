require('dotenv').config(); 
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors({
  origin: '*'
}));

const TOKEN = process.env.TOKEN;

app.get('/thing', async (req, res) => {
  const id = req.query.id;
  const response = await axios.get(
    `https://api.geekdo.com/api/geekitems?objectid=${id}&objecttype=thing`,
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
  res.send(response.data);
});

app.get('/imagem', async (req, res) => {
  try {
    const url = req.query.url;
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const contentType = response.headers['content-type'];
    res.set('Content-Type', contentType);
    res.send(response.data);
  } catch (error) {
    res.status(500).send(error.message);
  }
});


app.listen(3000, () => console.log('Servidor rodando em http://localhost:3000'));