# Telegram → Anki Import Bot

Telegram bot that collects vocabulary during lessons and imports it into Anki as flashcards.

The bot accepts words or phrases, processes them with the OpenAI API, generates translations and examples, downloads audio pronunciation, and adds cards to Anki using AnkiConnect.

## Features

* Collects words and phrases sent to the bot
* Uses OpenAI (gpt-4.1-mini) to:
    * extract vocabulary items
    * generate Russian translations
    * generate example sentences
    * assign decks and tags (CEFR level, part of speech)
* Deduplicates against both the queue and existing Anki cards
* Downloads pronunciation audio via Google Translate TTS
* Preview generated cards before importing
* Batch imports cards via AnkiConnect
* LLM results cached in SQLite to avoid redundant API calls
* Token usage tracking with cost estimate (`/stats`)

## Workflow

1. Send words or phrases to the bot in Telegram (comma-, semicolon-, or newline-separated).
2. The bot silently stores them in a queue and keeps one persistent queue message updated.
3. Press **Generate flashcards** to process the queue with OpenAI.
4. Review the card preview (word, translation, example, deck, tags).
5. Press **Send to Anki** to import, or **Cancel** to go back.

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Show the queue message |
| `/clear` | Clear the queue |
| `/resync` | Rebuild the local Anki word cache |
| `/stats` | Show token usage and estimated cost (admin only) |

## Requirements

* Node.js 18+
* Anki desktop app with the [AnkiConnect](https://ankiweb.net/shared/info/2055492159) addon

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
```

Only the user with `TELEGRAM_ADMIN_ID` can generate cards, import, clear the queue, or view stats.

## Run the bot

```
npm start
```

Anki must be open with AnkiConnect running on `http://localhost:8765` before starting the bot.

## Card format

Model: `Basic (and reversed card)`

Fields:

| Field | Content |
|-------|---------|
| Word | The vocabulary item |
| Translation | Russian translation |
| Example | Example sentence |
| Pronunciation | Audio file (MP3 from Google TTS) |

## Decks

Cards are assigned to one of:

* Health & Body
* Home & Daily Life
* Travel & Transport
* Food & Cooking
* Clothes & Appearance
* Nature & Environment
* Work & Career
* Personality & Emotions
* Objects & Concepts

## Tags

Each card gets two tags:

* `level∷A1` / `A2` / `B1` / `B2` / `C1`
* `pos∷noun` / `verb` / `adjective` / `adverb` / `phrase` / `phrasal_verb`

## Project structure

```
bot.js        Telegram polling, command/button handlers, import orchestration
config.js     Environment variables and constants
openai.js     OpenAI integration — card generation, deck/tag validation
anki.js       AnkiConnect HTTP client (3-retry logic)
tts.js        Google Translate TTS audio download
db.js         SQLite — queue, anki_words cache, llm_cache, settings tables
```
