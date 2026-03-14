# Telegram → Anki Import Bot

Telegram bot that collects vocabulary during lessons and imports it into Anki as cards.

The bot accepts words or phrases, processes them with the OpenAI API, generates translations and examples, downloads audio pronunciation, and adds cards to Anki using AnkiConnect.

## Features

* Collects words and phrases sent to the bot
* Uses OpenAI to:

    * extract vocabulary items
    * generate translations
    * generate example sentences
    * assign decks and tags
* Prevents duplicates by checking existing cards in Anki
* Downloads pronunciation audio
* Batch imports cards via AnkiConnect
* Persistent queue stored in SQLite

## Workflow

1. Send words or phrases to the bot in Telegram.
2. The bot silently stores them in a queue.
3. Press **Import to Anki** or send `/import`.
4. The bot:

    * processes vocabulary with OpenAI
    * filters duplicates
    * generates audio
    * adds cards to Anki.

## Requirements

* Node.js 14.21.3
* npm 6.14.18
* Anki
* AnkiConnect addon

## Installation

Clone the repository and install dependencies:

```
npm install
```

## Configuration

Create a `.env` file in the project root:

```
TELEGRAM_TOKEN=your_telegram_bot_token
OPENAI_API_KEY=your_openai_api_key
```

## Run the bot

```
npm start
```

## Anki setup

Install the **AnkiConnect** addon in Anki.

Default API endpoint:

```
http://localhost:8765
```

## Card format

Model:

```
Basic (and reversed card)
```

Fields used:

* Word
* Translation
* Example
* Pronunciation

## Project structure

```
bot.js        Telegram bot logic
config.js     environment configuration
openai.js     OpenAI integration
anki.js       AnkiConnect API
tts.js        audio generation
queue.js      queue management
db.js         SQLite storage
```
