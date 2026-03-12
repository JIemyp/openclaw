---
name: vector-memory
description: "Automatically indexes messages and injects relevant context from vector search"
homepage: https://docs.openclaw.ai/automation/hooks#vector-memory
metadata:
  {
    "openclaw":
      {
        "emoji": "🔍",
        "events": ["message:received", "message:sent", "agent:bootstrap"],
        "requires": { "config": ["workspace.dir"], "external": ["Python 3", "SQLite"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Vector Memory Hook

Automatically indexes every incoming and outgoing message into a vector database and injects relevant context during session bootstrap.

## What It Does

**Message Processing:**

1. **On message received** - Embeds and stores user messages with metadata
2. **On message sent** - Embeds and stores assistant responses with metadata
3. **On session bootstrap** - Searches vector database for relevant context and injects it into session

**Vector Search Integration:**

- Uses the existing `~/clawd/embeddings/` system
- Model: `intfloat/multilingual-e5-large` (1024 dimensions)
- Database: SQLite at `~/clawd/embeddings/karen.db`
- Python environment: `~/clawd/embeddings/venv/`

## Requirements

- **Python 3** with virtual environment at `~/clawd/embeddings/venv/`
- **SQLite** database initialized at `~/clawd/embeddings/karen.db`
- **Vector embedding system** configured with `embed.py` and `karen_search.py`
- **Config**: `workspace.dir` must be set

## Message Indexing

Messages are stored with metadata:

- **User messages**: `{'sender': 'user', 'channel': 'telegram', 'timestamp': 1234567890}`
- **Assistant responses**: `{'sender': 'assistant', 'channel': 'telegram', 'timestamp': 1234567890}`
- **Source type**: `chat` for all messages
- **Session key**: Captured for conversation tracking

Indexing runs asynchronously (fire-and-forget) to avoid blocking message processing.

## Context Injection

During `agent:bootstrap`, the hook:

1. Takes the last user message or first 200 chars of conversation
2. Searches the vector database for similar content
3. Returns top 5 most relevant results
4. Injects formatted context into the session bootstrap

**Example injected context:**

```markdown
## Relevant Context (Vector Search)

**Query**: "help with Python script"

**Similar conversations:**

- [0.876] projects/automation/scripts.md#debugging: "When debugging Python scripts, first check..."
- [0.823] memory/2026-03-10-python-help.md: "User asked about Python error handling..."
- [0.791] Previous conversation: "I had a similar Python issue last week..."
```

## Error Handling

- **Python script failures**: Logged but don't break chat processing
- **Vector search timeout**: 5 second maximum for bootstrap search
- **Missing dependencies**: Hook gracefully disables itself
- **Database unavailable**: Operations fail silently with logging

## Configuration

The hook supports optional configuration:

| Option    | Type    | Default | Description                         |
| --------- | ------- | ------- | ----------------------------------- |
| `timeout` | number  | 5       | Bootstrap search timeout in seconds |
| `limit`   | number  | 5       | Maximum context results to inject   |
| `enabled` | boolean | true    | Whether the hook is active          |

Example configuration:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "vector-memory": {
          "enabled": true,
          "timeout": 3,
          "limit": 8
        }
      }
    }
  }
}
```

## Python Script Execution

The hook executes Python scripts in the embeddings environment:

**Storage command:**

```bash
cd ~/clawd/embeddings && source venv/bin/activate && python3 -c "
from embed import store_embedding;
store_embedding('MESSAGE_TEXT', {'sender': 'user'}, 'chat')"
```

**Search command:**

```bash
cd ~/clawd/embeddings && source venv/bin/activate &&
python3 karen_search.py "QUERY" --limit 5 --json
```

## Disabling

To disable this hook:

```bash
openclaw hooks disable vector-memory
```

Or in config:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "vector-memory": { "enabled": false }
      }
    }
  }
}
```

## Privacy & Security

- Only message text content is indexed (no files, images, or attachments)
- All data stays local in SQLite database
- No external API calls for embeddings (local model)
- Session keys and metadata help maintain conversation context
