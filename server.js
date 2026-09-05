const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const client  = require('./es-client');

const app    = express();
const PORT   = 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const upload  = multer({ dest: UPLOADS_DIR });

const VOCAB_INDEX      = 'spanish_vocab';
const VERBS_INDEX      = 'spanish_verbs';
const CHILDREN_INDEX   = 'spanish_children';
const LISTS_INDEX      = 'spanish_lists';
const SESSIONS_INDEX   = 'spanish_sessions';
const QUIZ_STATE_INDEX = 'spanish_quiz_state';

app.use(express.static('public'));
app.use(express.json());

const REQUIRED_VERB_KEYS = ['infinitive', 'english', 'yo', 'tu', 'el', 'nosotros', 'vosotros', 'ellos'];

function childSlug(name) {
  return name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}
function wordSlug(str) {
  return str.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').substring(0, 60);
}
function listSlug(childId, name) {
  return `${childId}_${wordSlug(name)}`;
}

function parseWords(content) {
  let raw;
  try { raw = Function('"use strict"; return (' + content.trim() + ')')(); }
  catch (e) { throw new Error('Invalid format: ' + e.message); }
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Expected non-empty array');
  return raw.map((item, i) => {
    if (!Array.isArray(item) || item.length < 2)
      throw new Error(`Row ${i}: expected [spanish, english]`);
    const [spanish, english] = item.map(s => String(s).trim());
    if (!spanish || !english) throw new Error(`Row ${i}: empty value`);
    return { spanish, english };
  });
}

function parseVerbs(content) {
  const data = JSON.parse(content);
  if (!Array.isArray(data) || data.length === 0) throw new Error('Expected non-empty JSON array');
  for (const v of data) {
    for (const k of REQUIRED_VERB_KEYS) {
      if (!v[k] || typeof v[k] !== 'string')
        throw new Error(`Missing or invalid field "${k}" in verb "${v.infinitive || '?'}"`);
    }
  }
  return data;
}

// ── Children ────────────────────────────────────────────
app.get('/api/children', async (req, res) => {
  try {
    const result = await client.search({
      index: CHILDREN_INDEX,
      query: { match_all: {} },
      sort: [{ name: 'asc' }],
      size: 200,
    });
    const children = result.hits.hits.map(h => ({ id: h._id, ...h._source }));
    res.json({ children });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/children', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const id      = childSlug(name.trim());
  const now     = new Date().toISOString();
  const defList = `${id}_default`;
  try {
    await client.index({
      index: CHILDREN_INDEX, id, refresh: 'wait_for',
      document: { name: name.trim(), created_at: now, last_active: now, active_list_id: defList },
    });
    await client.index({
      index: LISTS_INDEX, id: defList, refresh: 'wait_for',
      document: { child_id: id, name: 'Default', created_at: now },
    });
    res.json({ id, name: name.trim(), active_list_id: defList });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Lists ────────────────────────────────────────────────
app.get('/api/lists', async (req, res) => {
  const childId = req.query.child;
  if (!childId) return res.status(400).json({ error: 'child required' });
  try {
    const result = await client.search({
      index: LISTS_INDEX,
      query: { term: { child_id: childId } },
      sort: [{ created_at: 'asc' }],
      size: 200,
    });
    const lists = result.hits.hits.map(h => ({ id: h._id, ...h._source }));
    res.json({ lists });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/lists', async (req, res) => {
  const childId = req.query.child;
  if (!childId) return res.status(400).json({ error: 'child required' });
  const { name, cloneFrom } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const now    = new Date().toISOString();
  const newId  = listSlug(childId, name.trim());
  try {
    await client.index({
      index: LISTS_INDEX, id: newId,
      document: { child_id: childId, name: name.trim(), created_at: now },
    });
    if (cloneFrom) {
      const srcDocs = await client.search({
        index: VOCAB_INDEX,
        query: { term: { list_id: cloneFrom } },
        size: 2000,
      });
      if (srcDocs.hits.hits.length > 0) {
        const vocabOps = srcDocs.hits.hits.flatMap(h => [
          { index: { _index: VOCAB_INDEX, _id: `${newId}_${wordSlug(h._source.spanish)}` } },
          { child_id: childId, list_id: newId, spanish: h._source.spanish, english: h._source.english, created_at: now, updated_at: now },
        ]);
        await client.bulk({ operations: vocabOps });
      }
      const srcVerbs = await client.search({
        index: VERBS_INDEX,
        query: { term: { list_id: cloneFrom } },
        size: 2000,
      });
      if (srcVerbs.hits.hits.length > 0) {
        const verbOps = srcVerbs.hits.hits.flatMap(h => {
          const { child_id, list_id, created_at, updated_at, ...verb } = h._source;
          return [
            { index: { _index: VERBS_INDEX, _id: `${newId}_${wordSlug(verb.infinitive)}` } },
            { child_id: childId, list_id: newId, ...verb, created_at: now, updated_at: now },
          ];
        });
        await client.bulk({ operations: verbOps });
      }
    }
    res.json({ id: newId, name: name.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/lists/active', async (req, res) => {
  const childId = req.query.child;
  const { listId } = req.body;
  if (!childId || !listId) return res.status(400).json({ error: 'child and listId required' });
  try {
    await client.update({ index: CHILDREN_INDEX, id: childId, doc: { active_list_id: listId } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/lists/rename', async (req, res) => {
  const childId = req.query.child;
  const { listId, name } = req.body;
  if (!childId || !listId || !name) return res.status(400).json({ error: 'child, listId, name required' });
  try {
    await client.update({ index: LISTS_INDEX, id: listId, doc: { name: name.trim() } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/lists', async (req, res) => {
  const childId = req.query.child;
  const listId  = req.query.list;
  if (!childId || !listId) return res.status(400).json({ error: 'child and list required' });
  try {
    await client.deleteByQuery({ index: VOCAB_INDEX, query: { term: { list_id: listId } } });
    await client.deleteByQuery({ index: VERBS_INDEX, query: { term: { list_id: listId } } });
    await client.delete({ index: LISTS_INDEX, id: listId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Words ────────────────────────────────────────────────
app.get('/api/words', async (req, res) => {
  const { child, list } = req.query;
  if (!child || !list) return res.status(400).json({ error: 'child and list required' });
  try {
    const result = await client.search({
      index: VOCAB_INDEX,
      query: { bool: { must: [{ term: { child_id: child } }, { term: { list_id: list } }] } },
      size: 2000,
    });
    const pairs = result.hits.hits.map(h => ({ spanish: h._source.spanish, english: h._source.english }));
    res.json({ pairs, count: pairs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/word', async (req, res) => {
  const { child, list } = req.query;
  if (!child || !list) return res.status(400).json({ error: 'child and list required' });
  const { spanish, english } = req.body;
  if (!spanish || !english) return res.status(400).json({ error: 'spanish and english required' });
  const now = new Date().toISOString();
  try {
    await client.index({
      index: VOCAB_INDEX,
      id: `${list}_${wordSlug(spanish)}`,
      refresh: 'wait_for',
      document: { child_id: child, list_id: list, spanish: spanish.trim(), english: english.trim(), created_at: now, updated_at: now },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/word', async (req, res) => {
  const { child, list } = req.query;
  if (!child || !list) return res.status(400).json({ error: 'child and list required' });
  const { originalSpanish, spanish, english } = req.body;
  if (!spanish || !english) return res.status(400).json({ error: 'spanish and english required' });
  const now = new Date().toISOString();
  try {
    const newId = `${list}_${wordSlug(spanish)}`;
    const oldId = `${list}_${wordSlug(originalSpanish || spanish)}`;
    if (oldId !== newId) await client.delete({ index: VOCAB_INDEX, id: oldId }).catch(() => {});
    await client.index({
      index: VOCAB_INDEX, id: newId,
      document: { child_id: child, list_id: list, spanish: spanish.trim(), english: english.trim(), created_at: now, updated_at: now },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/word', async (req, res) => {
  const { child, list, spanish } = req.query;
  if (!list || !spanish) return res.status(400).json({ error: 'list and spanish required' });
  try {
    await client.delete({ index: VOCAB_INDEX, id: `${list}_${wordSlug(spanish)}` });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload-words', upload.single('file'), async (req, res) => {
  const { child, list } = req.query;
  if (!child || !list) return res.status(400).json({ error: 'child and list required' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const content = fs.readFileSync(req.file.path, 'utf8');
    const pairs   = parseWords(content);
    const now     = new Date().toISOString();
    const ops = pairs.flatMap(p => [
      { index: { _index: VOCAB_INDEX, _id: `${list}_${wordSlug(p.spanish)}` } },
      { child_id: child, list_id: list, spanish: p.spanish, english: p.english, created_at: now, updated_at: now },
    ]);
    const bulkRes = await client.bulk({ operations: ops });
    fs.unlinkSync(req.file.path);
    if (bulkRes.errors) return res.status(500).json({ error: 'Bulk errors', details: bulkRes.items.filter(i => i.index?.error) });
    await client.update({ index: CHILDREN_INDEX, id: child, doc: { last_active: now } }).catch(() => {});
    res.json({ success: true, count: pairs.length });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(400).json({ error: err.message });
  }
});

// ── Verbs ────────────────────────────────────────────────
app.get('/api/verbs', async (req, res) => {
  const { child, list } = req.query;
  if (!child || !list) return res.status(400).json({ error: 'child and list required' });
  try {
    const result = await client.search({
      index: VERBS_INDEX,
      query: { bool: { must: [{ term: { child_id: child } }, { term: { list_id: list } }] } },
      size: 2000,
    });
    const verbs = result.hits.hits.map(h => {
      const { child_id, list_id, created_at, updated_at, ...verb } = h._source;
      return verb;
    });
    res.json({ verbs, count: verbs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/verb', async (req, res) => {
  const { child, list } = req.query;
  if (!child || !list) return res.status(400).json({ error: 'child and list required' });
  const verb = req.body;
  try {
    for (const k of REQUIRED_VERB_KEYS) {
      if (!verb[k] || typeof verb[k] !== 'string') return res.status(400).json({ error: `Missing field: ${k}` });
    }
    const now = new Date().toISOString();
    await client.index({
      index: VERBS_INDEX,
      id: `${list}_${wordSlug(verb.infinitive)}`,
      refresh: 'wait_for',
      document: { child_id: child, list_id: list, ...verb, created_at: now, updated_at: now },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/verb', async (req, res) => {
  const { child, list } = req.query;
  if (!child || !list) return res.status(400).json({ error: 'child and list required' });
  const verb = req.body;
  try {
    for (const k of REQUIRED_VERB_KEYS) {
      if (!verb[k] || typeof verb[k] !== 'string') return res.status(400).json({ error: `Missing field: ${k}` });
    }
    const now   = new Date().toISOString();
    const newId = `${list}_${wordSlug(verb.infinitive)}`;
    const oldId = `${list}_${wordSlug(verb.originalInfinitive || verb.infinitive)}`;
    if (oldId !== newId) await client.delete({ index: VERBS_INDEX, id: oldId }).catch(() => {});
    const { originalInfinitive, ...verbData } = verb;
    await client.index({
      index: VERBS_INDEX, id: newId,
      document: { child_id: child, list_id: list, ...verbData, created_at: now, updated_at: now },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/verb', async (req, res) => {
  const { list, infinitive } = req.query;
  if (!list || !infinitive) return res.status(400).json({ error: 'list and infinitive required' });
  try {
    await client.delete({ index: VERBS_INDEX, id: `${list}_${wordSlug(infinitive)}` });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  const { child, list } = req.query;
  if (!child || !list) return res.status(400).json({ error: 'child and list required' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const content = fs.readFileSync(req.file.path, 'utf8');
    const verbs   = parseVerbs(content);
    const now     = new Date().toISOString();
    const ops = verbs.flatMap(v => [
      { index: { _index: VERBS_INDEX, _id: `${list}_${wordSlug(v.infinitive)}` } },
      { child_id: child, list_id: list, ...v, created_at: now, updated_at: now },
    ]);
    const bulkRes = await client.bulk({ operations: ops });
    fs.unlinkSync(req.file.path);
    if (bulkRes.errors) return res.status(500).json({ error: 'Bulk errors', details: bulkRes.items.filter(i => i.index?.error) });
    await client.update({ index: CHILDREN_INDEX, id: child, doc: { last_active: now } }).catch(() => {});
    res.json({ success: true, count: verbs.length });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(400).json({ error: err.message });
  }
});

// ── Sessions ──────────────────────────────────────────────
app.post('/api/sessions', async (req, res) => {
  try {
    const { child_id, list_id, list_name, mode, total_words, first_try_correct,
            first_try_pct, needed_retry, total_misses, retry_breakdown } = req.body;
    if (!child_id || !list_id || !mode) return res.status(400).json({ error: 'child_id, list_id, mode required' });
    const doc = {
      child_id, list_id, list_name: list_name || '', mode,
      completed_at: new Date().toISOString(),
      total_words: total_words || 0,
      first_try_correct: first_try_correct || 0,
      first_try_pct: first_try_pct || 0,
      needed_retry: needed_retry || 0,
      total_misses: total_misses || 0,
      retry_breakdown: Array.isArray(retry_breakdown) ? retry_breakdown : [],
    };
    // ensure index exists (serverless auto-creates on first doc)
    const result = await client.index({ index: SESSIONS_INDEX, document: doc, refresh: 'wait_for' });
    res.json({ id: result._id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/sessions', async (req, res) => {
  const { child, list, size = 50 } = req.query;
  if (!child) return res.status(400).json({ error: 'child required' });
  try {
    const must = [{ term: { child_id: child } }];
    if (list) must.push({ term: { list_id: list } });
    const result = await client.search({
      index: SESSIONS_INDEX,
      query: { bool: { must } },
      sort: [{ completed_at: { order: 'desc' } }],
      size: Math.min(parseInt(size) || 50, 200),
    });
    res.json(result.hits.hits.map(h => ({ id: h._id, ...h._source })));
  } catch (err) {
    if (err.meta?.statusCode === 404) return res.json([]); // index not yet created
    res.status(500).json({ error: err.message });
  }
});

// ── Quiz State ────────────────────────────────────────────
function quizStateId(child, list, mode) { return `${child}_${list}_${mode}`; }

app.get('/api/quiz-state', async (req, res) => {
  const { child, list, mode } = req.query;
  if (!child || !list || !mode) return res.status(400).json({ error: 'child, list, mode required' });
  try {
    const doc = await client.get({ index: QUIZ_STATE_INDEX, id: quizStateId(child, list, mode) });
    res.json(doc._source);
  } catch (err) {
    if (err.meta?.statusCode === 404) return res.json(null);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/quiz-state', async (req, res) => {
  const { child_id, list_id, mode } = req.body;
  if (!child_id || !list_id || !mode) return res.status(400).json({ error: 'child_id, list_id, mode required' });
  try {
    await client.index({
      index: QUIZ_STATE_INDEX,
      id: quizStateId(child_id, list_id, mode),
      document: { ...req.body, updated_at: new Date().toISOString() },
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/quiz-state', async (req, res) => {
  const { child, list, mode } = req.query;
  if (!child || !list || !mode) return res.status(400).json({ error: 'child, list, mode required' });
  try {
    await client.delete({ index: QUIZ_STATE_INDEX, id: quizStateId(child, list, mode) });
    res.json({ success: true });
  } catch (err) {
    if (err.meta?.statusCode === 404) return res.json({ success: true });
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Spanish tester running at http://localhost:${PORT}`);
});
