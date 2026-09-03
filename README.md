# Spanish Tester

Interactive Spanish study app with vocabulary flashcards and verb conjugation practice. Backed by Elasticsearch — multi-child (multi-learner) support with per-child word sets.

## What it does

### Vocabulary Mode
- Flashcard quiz on Spanish/English word pairs
- Toggle direction: ES → EN or EN → ES
- Wrong answers re-queue until answered correctly
- "That's actually right" dispute button
- Retry wrong answers separately after finishing

### Verb Conjugation Mode
- Tests all 6 conjugation forms (yo / tú / él / nosotros / vosotros / ellos) plus English meaning
- Dispute button works here too

### Multi-child sessions
- Select the active learner from the dropdown at the top
- Each child has their own word set and wrong-answer history
- Add a new child via "+ New Child" — supply a vocab file (required) and verb file (optional)
- Wrong-answer history is namespaced per child in localStorage; word data lives in Elasticsearch

## Setup

### 1. Prerequisites

- Node.js (LTS)
- An Elasticsearch cluster (Elastic Cloud or self-hosted)

### 2. Clone and install

```bash
git clone https://github.com/your-username/spanish-tester.git
cd spanish-tester
npm install
```

### 3. Configure Elasticsearch

Create `variables.env` in the project root:

```
ES_URL=https://<your-cluster>.es.<region>.aws.elastic.cloud
API_KEY=<your-api-key>
```

### 4. Create Elasticsearch indices

```bash
node elastic-indices-and-settings/create-indices.js
```

This creates the three indices (`spanish_children`, `spanish_vocab`, `spanish_verbs`) using the mappings and settings defined in `elastic-indices-and-settings/`. Safe to re-run — skips indices that already exist.

To **delete and recreate** all indices (destructive — clears all data):

```bash
node elastic-indices-and-settings/create-indices.js --recreate
```

### 5. Seed initial data (Saifan)

```bash
node setup-es.js
```

Creates indices (if missing) and seeds Saifan's words from `words/test-terms.txt` and `words/verbs.json`. Idempotent — safe to re-run.

### 6. Start the app

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Elasticsearch indices

All definitions live in `elastic-indices-and-settings/`:

| File | Index | Description |
|------|-------|-------------|
| `spanish_children.json` | `spanish_children` | Child registry. `_id = child_slug` (e.g. `saifan`). |
| `spanish_vocab.json` | `spanish_vocab` | Vocab word pairs per child. `_id = {child_slug}_{word_slug}`. |
| `spanish_verbs.json` | `spanish_verbs` | Verb conjugation data per child. `_id = {child_slug}_{infinitive_slug}`. |

The `_id` pattern enables word-level upserts without rewriting the full word set.

## Custom word lists

### Vocabulary (`.txt`)
Array of `[spanish, english]` pairs:
```js
[
  ['hola', 'hello'],
  ['gracias', 'thank you']
]
```

### Verbs (`.json`)
Array of verb objects with all conjugation fields:
```json
[
  {
    "infinitive": "bailar",
    "english": "to dance",
    "yo": "bailo",
    "tu": "bailas",
    "el": "baila",
    "nosotros": "bailamos",
    "vosotros": "bailáis",
    "ellos": "bailan"
  }
]
```

Upload files in-app via the "Upload" section, or use the `/api/upload-words?child=<id>` and `/api/upload?child=<id>` endpoints directly.
