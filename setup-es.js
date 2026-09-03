#!/usr/bin/env node
// Creates indices (via elastic-indices-and-settings/) + seeds Saifan's data.
// Idempotent — safe to re-run. Skips existing indices and existing child.
//
// Usage: node setup-es.js

const client = require('./es-client');
const fs     = require('fs');
const path   = require('path');

const VOCAB_INDEX    = 'spanish_vocab';
const VERBS_INDEX    = 'spanish_verbs';
const CHILDREN_INDEX = 'spanish_children';

const DEFS_DIR = path.join(__dirname, 'elastic-indices-and-settings');

function childSlug(name) {
  return name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function wordSlug(str) {
  return str.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').substring(0, 60);
}

async function createIndex(defFile) {
  const def  = JSON.parse(fs.readFileSync(path.join(DEFS_DIR, defFile), 'utf8'));
  const { index, settings, mappings } = def;
  const exists = await client.indices.exists({ index });
  if (exists) { console.log(`  index "${index}" already exists — skipping create`); return; }
  await client.indices.create({ index, settings, mappings });
  console.log(`  created index "${index}"`);
}

async function setup() {
  console.log('Creating indices…');
  await createIndex('spanish_children.json');
  await createIndex('spanish_vocab.json');
  await createIndex('spanish_verbs.json');

  // Seed Saifan
  const childId = childSlug('saifan');
  const now = new Date().toISOString();

  console.log('\nSeeding child "Saifan"…');
  await client.index({
    index: CHILDREN_INDEX,
    id: childId,
    document: { name: 'Saifan', created_at: now, last_active: now },
  });

  // Parse vocab
  const wordsContent = fs.readFileSync(path.join(__dirname, 'words', 'test-terms.txt'), 'utf8');
  const rawPairs = Function('"use strict"; return (' + wordsContent.trim() + ')')();
  const pairs = rawPairs.map(([spanish, english]) => ({
    spanish: String(spanish).trim(),
    english: String(english).trim(),
  }));

  console.log(`  Indexing ${pairs.length} vocab words…`);
  const vocabOps = pairs.flatMap(p => [
    { index: { _index: VOCAB_INDEX, _id: `${childId}_${wordSlug(p.spanish)}` } },
    { child_id: childId, spanish: p.spanish, english: p.english, created_at: now, updated_at: now },
  ]);
  const vocabRes = await client.bulk({ operations: vocabOps });
  if (vocabRes.errors) {
    const errs = vocabRes.items.filter(i => i.index?.error);
    console.error('  Vocab bulk errors:', JSON.stringify(errs.slice(0, 3)));
  } else {
    console.log(`  ${pairs.length} vocab words indexed`);
  }

  // Parse verbs
  const verbsContent = fs.readFileSync(path.join(__dirname, 'words', 'verbs.json'), 'utf8');
  const verbs = JSON.parse(verbsContent);

  console.log(`  Indexing ${verbs.length} verbs…`);
  const verbOps = verbs.flatMap(v => [
    { index: { _index: VERBS_INDEX, _id: `${childId}_${wordSlug(v.infinitive)}` } },
    { child_id: childId, ...v, created_at: now, updated_at: now },
  ]);
  const verbRes = await client.bulk({ operations: verbOps });
  if (verbRes.errors) {
    const errs = verbRes.items.filter(i => i.index?.error);
    console.error('  Verb bulk errors:', JSON.stringify(errs.slice(0, 3)));
  } else {
    console.log(`  ${verbs.length} verbs indexed`);
  }

  console.log('\nSetup complete.');
}

setup().catch(err => { console.error(err); process.exit(1); });
