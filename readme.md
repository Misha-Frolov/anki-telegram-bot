# Telegram → Anki Import Bot

Telegram bot that collects vocabulary and imports it into Anki as flashcards. Supports multiple users: the admin imports
to Anki, other users export a CSV file compatible with Quizlet and other apps.

## Features

* Multi-user support with three roles: Admin, Teacher, User
* Collects words and phrases sent to the bot into a personal queue
* Translates and generates example sentences via OpenAI (gpt-4.1-mini) or Google Translate
* Any language → Russian translation
* Admin: preview cards → import to Anki with pronunciation audio (Google TTS)
* Users: preview cards → export CSV or Quizlet-compatible text
* Deduplication against the queue and existing Anki cards (admin, checked at input and at generate)
* Invalid words filtered before translation (GPT prompt instruction; Free Dictionary API / Wiktionary for Google Translate)
* LLM results cached in SQLite to avoid redundant API calls
* Per-user token usage and cost tracking (`/stats`, admin only)

## Roles

| Role        | How to configure              | Behaviour                                                        |
|-------------|-------------------------------|------------------------------------------------------------------|
| **Admin**   | `TELEGRAM_ADMIN_ID` in `.env` | Full access: generate cards, import to Anki, `/stats`, `/resync` |
| **Teacher** | `TEACHER_IDS` in `.env`       | Words go to the admin's queue; receives a temporary confirmation |
| **User**    | Everyone else                 | Personal queue, generate cards, export CSV / plain text          |

## Workflow

### Admin

1. Send words or phrases (comma-, semicolon-, or newline-separated).
2. Press **Generate flashcards** — OpenAI generates translations, examples, decks, and tags.
3. Review the card preview.
4. Press **Send to Anki** to import, or **Cancel** to go back.

### User

1. On first `/start`, choose your language from the picker (or type it via **Other →**).
2. Send words or phrases.
3. Press **Generate flashcards**.
4. Press **Get CSV** or **For Quizlet** (can press both).
5. Press **Done** when finished — the preview stays in chat as a record.

## Commands

| Command            | Who        | Description                                    |
|--------------------|------------|------------------------------------------------|
| `/start`           | All        | Show the queue message                         |
| `/clear`           | All        | Clear your own queue                           |
| `/lang [language]` | Users only | Set translation language, e.g. `/lang Turkish` |
| `/stats`           | Admin      | Per-user token usage and estimated cost        |
| `/resync`          | Admin      | Rebuild the local Anki word cache              |

## Requirements

* Node.js 18+
* Anki desktop app with the [AnkiConnect](https://ankiweb.net/shared/info/2055492159) addon (admin only)

## Installation

```
npm install
```

## Configuration

Create a `.env` file in the project root:

```
TELEGRAM_TOKEN=your_telegram_bot_token
OPENAI_API_KEY=your_openai_api_key
TELEGRAM_ADMIN_ID=your_numeric_telegram_user_id

# Optional
TEACHER_IDS=123456789,987654321
TRANSLATE_ENGINE=gpt        # gpt (default, with examples) or google (free, no examples)
ANKI_URL=http://localhost:8765
```

## Run the bot

```
npm start
```

For the admin's Anki import to work, Anki must be open with AnkiConnect running. The bot itself can run without Anki —
words are queued and imported later.

## Card format (admin / Anki)

Model: `Basic (and reversed card)`

| Field         | Content                          |
|---------------|----------------------------------|
| Word          | The vocabulary item              |
| Translation   | Russian translation              |
| Example       | Example sentence                 |
| Pronunciation | Audio file (MP3 from Google TTS) |

Decks: Health & Body, Home & Daily Life, Travel & Transport, Food & Cooking, Clothes & Appearance, Nature & Environment,
Work & Career, Personality & Emotions, Objects & Concepts

Tags: `level∷A1/A2/B1/B2/C1` and `pos∷noun/verb/adjective/adverb/phrase/phrasal_verb`

## Export formats (users)

**CSV** (`Get CSV`): tab-separated with Anki-compatible header (`#separator:tab`). Importable into Anki, Excel, and most flashcard apps.

**Quizlet text** (`For Quizlet`): `word;translation` per line. 
In Quizlet Import set separator *Between term and definition* to `;` (semicolon) and *Between cards* to *New line*.
The bot sends a 📋 Copy button for convenience.

## Project structure

```
bot.js        Telegram polling, command/button handlers, orchestration
config.js     Environment variables and constants
openai.js     OpenAI integration — card generation with language support
translate.js  Google Translate free API (TRANSLATE_ENGINE=google)
csv.js        CSV and plain text export
anki.js       AnkiConnect HTTP client (3-retry logic)
tts.js        Google Translate TTS audio download
db.js         SQLite — per-user queues, anki_words cache, llm_cache, settings
```