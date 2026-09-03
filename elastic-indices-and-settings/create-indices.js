#!/usr/bin/env node
// Creates all Elasticsearch indices from the JSON definitions in this folder.
// Safe to run on a fresh cluster — skips indices that already exist.
// Does NOT seed any data; run ../setup-es.js to seed initial child data.
//
// Usage:
//   node elastic-indices-and-settings/create-indices.js
//
// To delete and recreate an index (destructive — loses all data):
//   node elastic-indices-and-settings/create-indices.js --recreate

const client = require('../es-client');
const fs     = require('fs');
const path   = require('path');

const RECREATE = process.argv.includes('--recreate');

const DEFINITIONS = [
  'spanish_children.json',
  'spanish_vocab.json',
  'spanish_verbs.json',
].map(f => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')));

async function run() {
  for (const def of DEFINITIONS) {
    const { index, settings, mappings } = def;
    const exists = await client.indices.exists({ index });

    if (exists) {
      if (RECREATE) {
        process.stdout.write(`  deleting "${index}"… `);
        await client.indices.delete({ index });
        console.log('deleted');
      } else {
        console.log(`  "${index}" already exists — skipping (use --recreate to overwrite)`);
        continue;
      }
    }

    process.stdout.write(`  creating "${index}"… `);
    await client.indices.create({ index, settings, mappings });
    console.log('done');
  }
  console.log('\nAll indices ready.');
}

run().catch(err => { console.error(err.message); process.exit(1); });
