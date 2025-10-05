
# Retrieval & KB Indexing

## Files & Paths
- **KB index path:** `./data/kb_index.json` (watched with chokidar for hot‑reload) 
- The bot logs how many chunks are loaded and reloads on file change. 

## Commands
- `!reloadkb` — forces a KB reload at runtime (mods/broadcaster only). 

## Embeddings & Scoring
- **Embed endpoint:** `POST {OLLAMA_HOST}/api/embeddings` with `EMBED_MODEL` (current project default is bge-m3, previously nomic-embed-text) 
- **Cosine similarity** used for ranking. Top‑K (default 3) returned. 
- Retrieval flow:
  1) Embed the user query  
  2) Score docs in `kb_index.json` via cosine  
  3) Take top 3 and pass as “Context” to the chat call. 

## Chat Handling
- `!ask <question>` or `@charity_the_adventurer <question>` triggers build of:
  - **Live/channel context** (works online or offline)  
  - **KB context** (Top‑K hits)  
  Then the LLM is prompted to answer using ONLY that context. 

## KB Format
`data/kb_index.json` is expected to contain:
```json
{
  "docs": [
    {
      "file": "path-or-title",
      "text": "short chunk of text",
      "vec": [0.12, -0.03, ...]  // embedding vector for 'text'
    }
  ]
}

// Indexing Notes
Provide a local “indexer” script that:
Reads source docs (e.g., Markdown/Notes)
Splits into chunks
Calls embeddings, writes docs[] with text, file, and vec to data/kb_index.json
The bot will auto‑pick up changes via chokidar and !reloadkb.
Malformed kb_index.json is gracefully handled and !reloadkb is available