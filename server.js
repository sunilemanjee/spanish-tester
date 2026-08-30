const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const VERBS_FILE = path.join(__dirname, 'words', 'verbs.json');
const WORDS_FILE = path.join(__dirname, 'words', 'test-terms.txt');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

const upload = multer({ dest: UPLOADS_DIR });

app.use(express.static('public'));
app.use(express.json());

const REQUIRED_KEYS = ['infinitive', 'english', 'yo', 'tu', 'el', 'nosotros', 'vosotros', 'ellos'];

function parseWords(content) {
  // Use Function constructor to safely evaluate the JS array literal
  let raw;
  try {
    raw = Function('"use strict"; return (' + content.trim() + ')')();
  } catch (e) {
    throw new Error('Invalid format: ' + e.message);
  }
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Expected non-empty array');
  const pairs = raw.map((item, i) => {
    if (!Array.isArray(item) || item.length < 2)
      throw new Error(`Row ${i}: expected [spanish, english]`);
    const [spanish, english] = item.map(s => String(s).trim());
    if (!spanish || !english) throw new Error(`Row ${i}: empty value`);
    return { spanish, english };
  });
  return pairs;
}

app.get('/api/words', (req, res) => {
  try {
    const content = fs.readFileSync(WORDS_FILE, 'utf8');
    const pairs = parseWords(content);
    res.json({ pairs, count: pairs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload-words', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const content = fs.readFileSync(req.file.path, 'utf8');
    const pairs = parseWords(content);
    fs.writeFileSync(WORDS_FILE, content);
    fs.unlinkSync(req.file.path);
    res.json({ success: true, count: pairs.length });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(400).json({ error: err.message });
  }
});

function parseVerbs(content) {
  const data = JSON.parse(content);
  if (!Array.isArray(data) || data.length === 0) throw new Error('Expected non-empty JSON array');
  for (const v of data) {
    for (const k of REQUIRED_KEYS) {
      if (!v[k] || typeof v[k] !== 'string') {
        throw new Error(`Missing or invalid field "${k}" in verb "${v.infinitive || '?'}"`);
      }
    }
  }
  return data;
}

app.get('/api/verbs', (req, res) => {
  try {
    const content = fs.readFileSync(VERBS_FILE, 'utf8');
    const verbs = parseVerbs(content);
    res.json({ verbs, count: verbs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const content = fs.readFileSync(req.file.path, 'utf8');
    const verbs = parseVerbs(content);
    fs.mkdirSync(path.dirname(VERBS_FILE), { recursive: true });
    fs.writeFileSync(VERBS_FILE, content);
    fs.unlinkSync(req.file.path);
    res.json({ success: true, count: verbs.length });
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Spanish verb tester running at http://localhost:${PORT}`);
});
