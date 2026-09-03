#!/usr/bin/env node
// Creates indices + seeds Saifan's data. Idempotent — safe to re-run.
// Also migrates existing vocab/verb docs to list-scoped IDs if needed.
//
// Usage: node setup-es.js

const client = require('./es-client');
const fs     = require('fs');
const path   = require('path');

const VOCAB_INDEX    = 'spanish_vocab';
const VERBS_INDEX    = 'spanish_verbs';
const CHILDREN_INDEX = 'spanish_children';
const LISTS_INDEX    = 'spanish_lists';
const DEFS_DIR       = path.join(__dirname, 'elastic-indices-and-settings');

function childSlug(name) {
  return name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}
function wordSlug(str) {
  return str.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').substring(0, 60);
}

async function createIndex(defFile) {
  const def = JSON.parse(fs.readFileSync(path.join(DEFS_DIR, defFile), 'utf8'));
  const { index, mappings } = def;
  const exists = await client.indices.exists({ index });
  if (exists) { console.log(`  "${index}" already exists — skipping`); return; }
  // Omit settings — serverless Elastic Cloud manages shards/replicas automatically
  await client.indices.create({ index, mappings });
  console.log(`  created "${index}"`);
}

// Add list_id field mapping to existing index (no-op if already there)
async function ensureListIdMapping(index) {
  await client.indices.putMapping({
    index,
    properties: { list_id: { type: 'keyword' } },
  }).catch(() => {});
}

async function setup() {
  console.log('Creating indices…');
  await createIndex('spanish_children.json');
  await createIndex('spanish_lists.json');
  await createIndex('spanish_vocab.json');
  await createIndex('spanish_verbs.json');

  // Ensure list_id mapping on existing indices
  await ensureListIdMapping(VOCAB_INDEX);
  await ensureListIdMapping(VERBS_INDEX);

  const childId    = childSlug('saifan');
  const listId     = `${childId}_default`;
  const listDocId  = listId;
  const now        = new Date().toISOString();

  console.log('\nSeeding child "Saifan"…');

  // Upsert child (preserve existing fields)
  const childExists = await client.exists({ index: CHILDREN_INDEX, id: childId });
  if (!childExists) {
    await client.index({
      index: CHILDREN_INDEX, id: childId,
      document: { name: 'Saifan', created_at: now, last_active: now, active_list_id: listId },
    });
    console.log('  created child doc');
  } else {
    // Ensure active_list_id is set
    await client.update({
      index: CHILDREN_INDEX, id: childId,
      script: { source: "if (ctx._source.active_list_id == null) { ctx._source.active_list_id = params.lid }", params: { lid: listId } },
    });
    console.log('  child already exists — ensured active_list_id');
  }

  // Create default list if missing
  const listExists = await client.exists({ index: LISTS_INDEX, id: listDocId });
  if (!listExists) {
    await client.index({
      index: LISTS_INDEX, id: listDocId,
      document: { child_id: childId, name: 'Default', created_at: now },
    });
    console.log('  created "Default" list');
  } else {
    console.log('  "Default" list already exists');
  }

  // Migrate existing vocab docs (no list_id) → new IDs with list_id
  const oldVocab = await client.search({
    index: VOCAB_INDEX,
    query: { bool: { must: [{ term: { child_id: childId } }], must_not: [{ exists: { field: 'list_id' } }] } },
    size: 2000,
  });
  if (oldVocab.hits.hits.length > 0) {
    console.log(`  migrating ${oldVocab.hits.hits.length} vocab docs to list-scoped IDs…`);
    const delOps = oldVocab.hits.hits.map(h => ({ delete: { _index: VOCAB_INDEX, _id: h._id } }));
    const addOps = oldVocab.hits.hits.flatMap(h => [
      { index: { _index: VOCAB_INDEX, _id: `${listId}_${wordSlug(h._source.spanish)}` } },
      { ...h._source, list_id: listId, updated_at: now },
    ]);
    await client.bulk({ operations: delOps });
    await client.bulk({ operations: addOps });
    console.log('  vocab migration done');
  } else {
    console.log('  vocab already migrated or empty');
  }

  // Migrate existing verb docs (no list_id)
  const oldVerbs = await client.search({
    index: VERBS_INDEX,
    query: { bool: { must: [{ term: { child_id: childId } }], must_not: [{ exists: { field: 'list_id' } }] } },
    size: 2000,
  });
  if (oldVerbs.hits.hits.length > 0) {
    console.log(`  migrating ${oldVerbs.hits.hits.length} verb docs to list-scoped IDs…`);
    const delOps = oldVerbs.hits.hits.map(h => ({ delete: { _index: VERBS_INDEX, _id: h._id } }));
    const addOps = oldVerbs.hits.hits.flatMap(h => [
      { index: { _index: VERBS_INDEX, _id: `${listId}_${wordSlug(h._source.infinitive)}` } },
      { ...h._source, list_id: listId, updated_at: now },
    ]);
    await client.bulk({ operations: delOps });
    await client.bulk({ operations: addOps });
    console.log('  verb migration done');
  } else {
    console.log('  verbs already migrated or empty');
  }

  // If no vocab at all yet (fresh cluster), seed from files
  const vocabCount = await client.count({
    index: VOCAB_INDEX,
    query: { term: { list_id: listId } },
  });
  if (vocabCount.count === 0) {
    const content = fs.readFileSync(path.join(__dirname, 'words', 'test-terms.txt'), 'utf8');
    const raw     = Function('"use strict"; return (' + content.trim() + ')')();
    const pairs   = raw.map(([s, e]) => ({ spanish: String(s).trim(), english: String(e).trim() }));
    const ops = pairs.flatMap(p => [
      { index: { _index: VOCAB_INDEX, _id: `${listId}_${wordSlug(p.spanish)}` } },
      { child_id: childId, list_id: listId, spanish: p.spanish, english: p.english, created_at: now, updated_at: now },
    ]);
    await client.bulk({ operations: ops });
    console.log(`  seeded ${pairs.length} vocab words`);
  }

  const verbCount = await client.count({
    index: VERBS_INDEX,
    query: { term: { list_id: listId } },
  });
  if (verbCount.count === 0) {
    const verbs = JSON.parse(fs.readFileSync(path.join(__dirname, 'words', 'verbs.json'), 'utf8'));
    const ops = verbs.flatMap(v => [
      { index: { _index: VERBS_INDEX, _id: `${listId}_${wordSlug(v.infinitive)}` } },
      { child_id: childId, list_id: listId, ...v, created_at: now, updated_at: now },
    ]);
    await client.bulk({ operations: ops });
    console.log(`  seeded ${verbs.length} verbs`);
  }

  console.log('\nSetup complete.');
}

setup().catch(err => { console.error(err); process.exit(1); });
