const { Client } = require('@elastic/elasticsearch');
require('dotenv').config({ path: './variables.env' });

const client = new Client({
  node: process.env.ES_URL,
  auth: { apiKey: process.env.API_KEY },
});

module.exports = client;
