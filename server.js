const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const client  = require('./es-client');

const app    = express();
const PORT   = 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const upload  = multer({ dest: UPLOADS_DIR });

const VOCAB_INDEX    = 'spanish_vocab';
const VERBS_INDEX    = 'spanish_verbs';
const CHILDREN_INDEX = 'spanish_children';

app.use(express.static('public'));
app.use(express.json());

const REQUIRED_VERB_KEYS = ['infinitive', 'english', 'yo', 'tu', 'el', 'nosotros', 'vosotros', 'ellos'];

function childSlug(name) {
  return name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function wordSlug(str) {
  return str.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').substring(0, 60);
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
  const id  = childSlug(name.trim());
  const now = new Date().toISOString();
  try {
    await client.index({
      index: CHILDREN_INDEX,
      id,
      document: { name: name.trim(), created_at: now, last_active: now },
    });
    res.json({ id, name: name.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Words ───────────────────────────────────────────────
app.get('/api/words', async (req, res) => {
  const childId = req.query.child;
  if (!childId) return res.status(400).json({ error: 'child query param required' });
  try {
    const result = await client.search({
      index: VOCAB_INDEX,
      query: { term: { child_id: childId } },
      size: 1000,
    });
    const pairs = result.hits.hits.map(h => ({
      spanish: h._source.spanish,
      english: h._source.english,
    }));
    res.json({ pairs, count: pairs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload-words', upload.single('file'), async (req, res) => {
  const childId = req.query.child;
  if (!childId) return res.status(400).json({ error: 'child query param required' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const content = fs.readFileSync(req.file.path, 'utf8');
    const pairs   = parseWords(content);
    const now     = new Date().toISOString();
    const ops = pairs.flatMap(p => [
      { index: { _index: VOCAB_INDEX, _id: `${childId}_${wordSlug(p.spanish)}` } },
      { child_id: childId, spanish: p.spanish, english: p.english, created_at: now, updated_at: now },
    ]);
    const bulkRes = await client.bulk({ operations: ops });
    fs.unlinkSync(req.file.path);
    if (bulkRes.errors) {
      const errs = bulkRes.items.filter(i => i.index?.error);
      return res.status(500).json({ error: 'Bulk index errors', details: errs });
    }
    // Touch last_active
    await client.update({ index: CHILDREN_INDEX, id: childId, doc: { last_active: now } }).catch(() => {});
    res.json({ success: true, count: pairs.length });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(400).json({ error: err.message });
  }
});

// Single word add/update
app.post('/api/word', async (req, res) => {
  const childId = req.query.child;
  if (!childId) return res.status(400).json({ error: 'child query param required' });
  const { spanish, english } = req.body;
  if (!spanish || !english) return res.status(400).json({ error: 'spanish and english required' });
  const now = new Date().toISOString();
  try {
    await client.index({
      index: VOCAB_INDEX,
      id: `${childId}_${wordSlug(spanish)}`,
      document: { child_id: childId, spanish: spanish.trim(), english: english.trim(), created_at: now, updated_at: now },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Verbs ───────────────────────────────────────────────
app.get('/api/verbs', async (req, res) => {
  const childId = req.query.child;
  if (!childId) return res.status(400).json({ error: 'child query param required' });
  try {
    const result = await client.search({
      index: VERBS_INDEX,
      query: { term: { child_id: childId } },
      size: 1000,
    });
    const verbs = result.hits.hits.map(h => {
      const { child_id, created_at, updated_at, ...verb } = h._source;
      return verb;
    });
    res.json({ verbs, count: verbs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  const childId = req.query.child;
  if (!childId) return res.status(400).json({ error: 'child query param required' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const content = fs.readFileSync(req.file.path, 'utf8');
    const verbs   = parseVerbs(content);
    const now     = new Date().toISOString();
    const ops = verbs.flatMap(v => [
      { index: { _index: VERBS_INDEX, _id: `${childId}_${wordSlug(v.infinitive)}` } },
      { child_id: childId, ...v, created_at: now, updated_at: now },
    ]);
    const bulkRes = await client.bulk({ operations: ops });
    fs.unlinkSync(req.file.path);
    if (bulkRes.errors) {
      const errs = bulkRes.items.filter(i => i.index?.error);
      return res.status(500).json({ error: 'Bulk index errors', details: errs });
    }
    await client.update({ index: CHILDREN_INDEX, id: childId, doc: { last_active: now } }).catch(() => {});
    res.json({ success: true, count: verbs.length });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(400).json({ error: err.message });
  }
});

// Update word (handles Spanish rename: delete old doc, create new)
app.put('/api/word', async (req, res) => {
  const childId = req.query.child;
  if (!childId) return res.status(400).json({ error: 'child query param required' });
  const { originalSpanish, spanish, english } = req.body;
  if (!spanish || !english) return res.status(400).json({ error: 'spanish and english required' });
  const now = new Date().toISOString();
  try {
    const newId = `${childId}_${wordSlug(spanish)}`;
    const oldId = `${childId}_${wordSlug(originalSpanish || spanish)}`;
    if (oldId !== newId) {
      await client.delete({ index: VOCAB_INDEX, id: oldId }).catch(() => {});
    }
    await client.index({
      index: VOCAB_INDEX,
      id: newId,
      document: { child_id: childId, spanish: spanish.trim(), english: english.trim(), created_at: now, updated_at: now },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a word
app.delete('/api/word', async (req, res) => {
  const childId = req.query.child;
  const spanish  = req.query.spanish;
  if (!childId || !spanish) return res.status(400).json({ error: 'child and spanish required' });
  try {
    await client.delete({ index: VOCAB_INDEX, id: `${childId}_${wordSlug(spanish)}` });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single verb add/update
app.post('/api/verb', async (req, res) => {
  const childId = req.query.child;
  if (!childId) return res.status(400).json({ error: 'child query param required' });
  const verb = req.body;
  try {
    for (const k of REQUIRED_VERB_KEYS) {
      if (!verb[k] || typeof verb[k] !== 'string')
        return res.status(400).json({ error: `Missing field: ${k}` });
    }
    const now = new Date().toISOString();
    await client.index({
      index: VERBS_INDEX,
      id: `${childId}_${wordSlug(verb.infinitive)}`,
      document: { child_id: childId, ...verb, created_at: now, updated_at: now },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update verb (infinitive rename: delete old, create new)
app.put('/api/verb', async (req, res) => {
  const childId = req.query.child;
  if (!childId) return res.status(400).json({ error: 'child query param required' });
  const verb = req.body;
  const originalInfinitive = req.body.originalInfinitive;
  try {
    for (const k of REQUIRED_VERB_KEYS) {
      if (!verb[k] || typeof verb[k] !== 'string')
        return res.status(400).json({ error: `Missing field: ${k}` });
    }
    const now   = new Date().toISOString();
    const newId = `${childId}_${wordSlug(verb.infinitive)}`;
    const oldId = `${childId}_${wordSlug(originalInfinitive || verb.infinitive)}`;
    if (oldId !== newId) {
      await client.delete({ index: VERBS_INDEX, id: oldId }).catch(() => {});
    }
    const { originalInfinitive: _, ...verbData } = verb;
    await client.index({
      index: VERBS_INDEX,
      id: newId,
      document: { child_id: childId, ...verbData, created_at: now, updated_at: now },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a verb
app.delete('/api/verb', async (req, res) => {
  const childId    = req.query.child;
  const infinitive = req.query.infinitive;
  if (!childId || !infinitive) return res.status(400).json({ error: 'child and infinitive required' });
  try {
    await client.delete({ index: VERBS_INDEX, id: `${childId}_${wordSlug(infinitive)}` });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Spanish tester running at http://localhost:${PORT}`);
});
