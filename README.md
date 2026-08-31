# Spanish Tester

Interactive Spanish study app with two modes: vocabulary flashcards and verb conjugation practice.

## What it does

### Vocabulary Mode
- Flashcard-style quiz on 82 Spanish/English term pairs
- Toggle direction: ES → EN or EN → ES
- Wrong answers re-queue until answered correctly
- "That's actually right" dispute button to contest marked-wrong answers
- Tracks unique misses (not repeated attempts on same word)
- Retry wrong answers separately after finishing

### Verb Conjugation Mode
- Tests all 6 conjugation forms (yo / tú / él / nosotros / vosotros / ellos) plus English meaning
- 9 stem-changing verbs: pedir, repetir, empezar, preferir, querer, tener, dormir, poder, jugar
- Shows previous wrong answers on re-attempt
- Dispute button works here too

### Both modes
- Progress bar and live score (Mastered / Misses / To Go / 1st Try)
- Persistent wrong list via localStorage — survives page refresh
- Upload a custom word list or verb list via the in-app UI

## Installation & Launch

### 1. Install Node.js
Download and install from [nodejs.org](https://nodejs.org) (LTS version recommended). Verify:
```bash
node --version
npm --version
```

### 2. Clone the repo
```bash
git clone https://github.com/your-username/spanish-tester.git
cd spanish-tester
```

### 3. Install dependencies
```bash
npm install
```
This installs `express` (web server) and `multer` (file uploads).

### 4. Start the app
```bash
npm start
```
Or equivalently:
```bash
node server.js
```

### 5. Open in browser
Navigate to [http://localhost:3000](http://localhost:3000).

## Custom word lists

### Vocabulary (`words/test-terms.txt`)
Array of `[spanish, english]` pairs:
```js
[
  ['hola', 'hello'],
  ['gracias', 'thank you']
]
```

### Verbs (`words/verbs.json`)
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

Both files can also be uploaded directly in the app without editing files.
