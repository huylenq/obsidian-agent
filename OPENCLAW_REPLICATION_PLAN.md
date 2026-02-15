## OpenClaw Memory & Identity System Analysis

This document analyzes OpenClaw's **stateful memory** and **identity/soul** systems for replication in Huy's Obsidian Claude Agent plugin.

---

## 1. Memory System Architecture

OpenClaw implements a sophisticated **hybrid vector + full-text search** memory system with the following components:

### 1.1 Memory Sources

| Source | Location | Purpose |
|--------|----------|---------|
| `MEMORY.md` | `~/.openclaw/workspace/MEMORY.md` | Primary persistent memory file |
| `memory/*.md` | `~/.openclaw/workspace/memory/` | Individual memory entries (auto-generated per session) |
| Session transcripts | `~/.claude/projects/.../` | Past conversation history (optional source) |

### 1.2 Database Schema (SQLite + sqlite-vec)

```sql
-- Meta table for index versioning
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Indexed files tracking
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'memory',  -- 'memory' | 'sessions'
  hash TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL
);

-- Chunked content with embeddings
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'memory',
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  model TEXT NOT NULL,          -- embedding model used
  text TEXT NOT NULL,
  embedding TEXT NOT NULL,      -- JSON array of floats
  updated_at INTEGER NOT NULL
);

-- Vector index (sqlite-vec extension)
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[{dimensions}]
);

-- Full-text search index (FTS5)
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  id UNINDEXED,
  path UNINDEXED,
  source UNINDEXED,
  model UNINDEXED,
  start_line UNINDEXED,
  end_line UNINDEXED
);

-- Embedding cache (avoid re-embedding same text)
CREATE TABLE embedding_cache (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  hash TEXT NOT NULL,
  embedding TEXT NOT NULL,
  dims INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model, provider_key, hash)
);
```

### 1.3 Memory Tools (Claude-accessible)

**`memory_search`**:
```typescript
{
  name: "memory_search",
  description: "Mandatory recall step: semantically search MEMORY.md + memory/*.md
    (and optional session transcripts) before answering questions about prior work,
    decisions, dates, people, preferences, or todos; returns top snippets with path + lines.",
  parameters: {
    query: string,           // Search query
    maxResults?: number,     // Default from config
    minScore?: number        // Similarity threshold
  }
}
```

**`memory_get`**:
```typescript
{
  name: "memory_get",
  description: "Safe snippet read from MEMORY.md, memory/*.md, or configured
    memorySearch.extraPaths with optional from/lines; use after memory_search
    to pull only the needed lines and keep context small.",
  parameters: {
    path: string,           // Relative path to file
    from?: number,          // Starting line
    lines?: number          // Number of lines to read
  }
}
```

### 1.4 Hybrid Search Algorithm

```typescript
// Pseudo-code for hybrid search
async search(query: string): Promise<MemorySearchResult[]> {
  // 1. Full-text keyword search (BM25)
  const keywordResults = await this.searchKeyword(query, candidateCount);

  // 2. Vector similarity search
  const queryVec = await this.embedQuery(query);
  const vectorResults = await this.searchVector(queryVec, candidateCount);

  // 3. Merge with configurable weights
  const merged = mergeHybridResults({
    vector: vectorResults,
    keyword: keywordResults,
    vectorWeight: 0.7,  // default
    textWeight: 0.3     // default
  });

  return merged.filter(r => r.score >= minScore).slice(0, maxResults);
}
```

### 1.5 Session Memory Hook

When user runs `/new` to start fresh session, OpenClaw:

1. **Captures previous session** - Reads last N messages from transcript
2. **Generates descriptive slug** - Uses LLM to create filename like `2026-01-16-api-design.md`
3. **Saves to memory** - Creates file at `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram

## Conversation Summary

user: Can you help me design an API for...
assistant: I'd recommend a RESTful approach with...
```

### 1.6 Sync & Watch System

- **File watcher** (chokidar): Auto-sync on MEMORY.md or memory/*.md changes
- **Session listener**: Incremental indexing on session transcript updates
- **Delta tracking**: Only re-index changed portions (bytes/messages threshold)
- **Interval sync**: Configurable periodic full sync
- **Embedding cache**: Avoid re-computing embeddings for unchanged text chunks

---

## 2. Identity / Soul System

### 2.1 Bootstrap Files (Workspace Context)

OpenClaw loads these files from `~/.openclaw/workspace/` and injects into system prompt:

| File | Purpose |
|------|---------|
| `SOUL.md` | **Persona definition** - tone, personality, values, style |
| `USER.md` | **User profile** - who the user is, preferences, context |
| `IDENTITY.md` | Assistant's name, avatar, emoji for UI display |
| `TOOLS.md` | User guidance on external tools (not tool availability) |
| `AGENTS.md` | Multi-agent definitions and routing rules |
| `HEARTBEAT.md` | Prompt for periodic health checks |
| `BOOTSTRAP.md` | Additional bootstrap context |
| `MEMORY.md` | Persistent memory (also used for search) |

### 2.2 Soul File Structure

Example `SOUL.md`:
```markdown
# Soul

You are Pi, a personal AI assistant.

## Personality
- Warm, curious, and genuinely interested in helping
- Direct but not curt
- Uses humor sparingly but effectively
- Admits uncertainty rather than fabricating

## Communication Style
- Start responses directly without preamble
- Use markdown formatting thoughtfully
- Be concise unless depth is requested
- Match the user's energy level

## Values
- User privacy and autonomy above all
- Honest about capabilities and limitations
- Proactive in suggesting improvements
- Respectful of user's time
```

### 2.3 User Profile Structure

Example `USER.md`:
```markdown
# User Profile

## Who I Am
- Name: Huy
- Role: Software engineer, knowledge management enthusiast
- Location: [timezone for scheduling]

## Preferences
- Prefer code examples over explanations
- Use TypeScript unless specified otherwise
- Keep responses concise
- Don't use emojis unless I do first

## Context
- Working on Obsidian plugins
- Primary vault: ~/lifeos
- Use pnpm, not npm
```

### 2.4 Soul Evil Hook (Alternative Persona)

**Fascinating feature**: OpenClaw supports swapping the SOUL at runtime:

```typescript
// Configuration
{
  "hooks": {
    "internal": {
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,           // 10% random chance
          "purge": {
            "at": "21:00",         // Daily window start
            "duration": "15m"      // Window length
          }
        }
      }
    }
  }
}
```

**Triggers**:
- **Purge window**: During configured daily time window
- **Random chance**: X% probability per message

**What it does**: Replaces injected SOUL.md content with SOUL_EVIL.md - for fun "evil mode" or different persona experiments.

### 2.5 Identity Resolution

```typescript
// Identity is resolved from multiple sources with precedence:
function resolveAssistantIdentity(cfg, agentId): AssistantIdentity {
  return {
    name:
      cfg.ui?.assistant?.name ??          // 1. Explicit UI config
      agentIdentity?.name ??              // 2. Agent config
      fileIdentity?.name ??               // 3. IDENTITY.md file
      "Assistant",                        // 4. Default
    avatar:
      cfg.ui?.assistant?.avatar ??
      agentIdentity?.avatar ??
      agentIdentity?.emoji ??
      fileIdentity?.avatar ??
      fileIdentity?.emoji ??
      "A"
  };
}
```

---

## 3. System Prompt Construction

### 3.1 Injected Context Flow

```
System Prompt
├── ## Tooling (available tools list)
├── ## Tool Call Style
├── ## Safety (Anthropic-inspired constraints)
├── ## Skills (if any enabled)
├── ## Memory Recall (mandatory search instruction)
├── ## User Identity (from USER.md)
├── ## Current Date & Time
├── ## Workspace (working directory)
├── ## Messaging
├── ## Voice (TTS hints)
├── ## Runtime (agent/model/channel info)
│
└── # Project Context (bootstrap files)
    ├── ## SOUL.md (persona)
    ├── ## USER.md (user profile)
    ├── ## TOOLS.md (tool guidance)
    ├── ## IDENTITY.md
    ├── ## MEMORY.md (recent memory)
    └── ## AGENTS.md (if multi-agent)
```

### 3.2 Key System Prompt Sections

**Memory Recall Instruction**:
```
## Memory Recall
Before answering anything about prior work, decisions, dates, people, preferences,
or todos: run memory_search on MEMORY.md + memory/*.md; then use memory_get to
pull only the needed lines. If low confidence after search, say you checked.
```

**Soul Embodiment**:
```
If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies;
follow its guidance unless higher-priority instructions override it.
```

---

## 4. Replication Plan for Obsidian Claude Agent

### 4.1 Memory System

**What to implement:**

| Component | OpenClaw | Obsidian Replication |
|-----------|----------|---------------------|
| Vector store | SQLite + sqlite-vec | **Reuse Copilot index** (already done!) |
| FTS | SQLite FTS5 | Could add, but Copilot handles this |
| Memory files | `~/.openclaw/workspace/memory/` | `<vault>/.claude/memory/` |
| Session save | Hook on `/new` | Hook on `/done` command |
| Memory tools | `memory_search`, `memory_get` | MCP tools or inject into system prompt |

**Implementation approach:**

```typescript
// server/tools/memory.ts
export const memorySearchTool = {
  name: "memory_search",
  description: "Search your persistent memory for past decisions, preferences, and context",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      maxResults: { type: "number", default: 5 }
    },
    required: ["query"]
  },
  execute: async (params, context) => {
    // Use CopilotIndexReader for vector search
    const results = await context.vectorStore.search(params.query, {
      maxResults: params.maxResults,
      pathFilter: ".claude/memory/"  // Only search memory files
    });
    return results;
  }
};
```

### 4.2 Identity/Soul System

**Bootstrap files for Obsidian:**

| File | Location | Purpose |
|------|----------|---------|
| `SOUL.md` | `<vault>/.claude/SOUL.md` | Persona definition |
| `USER.md` | `<vault>/.claude/USER.md` | User profile |
| `MEMORY.md` | `<vault>/.claude/MEMORY.md` | Persistent memory |
| `TOOLS.md` | `<vault>/.claude/TOOLS.md` | Tool usage guidance |

**System prompt injection:**

```typescript
// server/routes/chat.js - extend buildSystemPrompt()
async function buildSystemPrompt(context) {
  const parts = [];

  // Load bootstrap files
  const bootstrapFiles = [
    { name: 'SOUL.md', path: '.claude/SOUL.md' },
    { name: 'USER.md', path: '.claude/USER.md' },
    { name: 'MEMORY.md', path: '.claude/MEMORY.md' },
    { name: 'TOOLS.md', path: '.claude/TOOLS.md' },
  ];

  for (const file of bootstrapFiles) {
    const content = await tryReadFile(join(context.vaultPath, file.path));
    if (content) {
      parts.push(`## ${file.name}\n\n${content}`);
    }
  }

  // Memory recall instruction (if memory exists)
  if (hasMemoryFiles) {
    parts.unshift(`## Memory Recall
Before answering questions about past work, decisions, preferences, or context,
search your memory first using the memory_search tool.`);
  }

  // Soul embodiment instruction
  if (hasSoulFile) {
    parts.unshift(`If SOUL.md is present, embody its persona and tone.`);
  }

  return parts.join('\n\n');
}
```

### 4.3 Session-to-Memory Hook

**On `/done` command:**

```typescript
// src/commands/builtins/done.ts
export const doneCommand: SlashCommand = {
  name: 'done',
  description: 'Mark session complete and save to memory',
  execute: async (context) => {
    // 1. Get session transcript
    const messages = context.getSessionMessages();

    // 2. Generate summary via Claude
    const summary = await generateSessionSummary(messages);

    // 3. Generate slug
    const slug = await generateSlug(messages);

    // 4. Save to memory
    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}-${slug}.md`;
    const memoryPath = join(context.vaultPath, '.claude/memory', filename);

    const content = `# Session: ${date}

## Summary
${summary}

## Key Points
${extractKeyPoints(messages)}
`;

    await writeFile(memoryPath, content);

    // 5. Clear session
    context.clearSession();

    return { success: true, message: `Session saved to ${filename}` };
  }
};
```

### 4.4 Quick Wins (Immediate Value)

1. **Create bootstrap file templates**:
   - Add command to scaffold `.claude/SOUL.md`, `.claude/USER.md`, etc.
   - Include sensible defaults

2. **Inject bootstrap files into system prompt**:
   - Modify `server/routes/chat.js` to read and inject these files
   - ~30 lines of code

3. **Add `/done` command with memory save**:
   - Save session summary to `.claude/memory/`
   - Use existing semantic search to retrieve later

4. **Memory search tool**:
   - Expose existing Copilot vector search as MCP tool
   - Filter to `.claude/memory/` directory

### 4.5 File Structure

```
<vault>/
├── .claude/
│   ├── SOUL.md           # Persona definition
│   ├── USER.md           # User profile
│   ├── MEMORY.md         # Persistent notes (manual)
│   ├── TOOLS.md          # Tool guidance
│   └── memory/
│       ├── 2026-02-10-api-design.md
│       ├── 2026-02-11-bug-fixing.md
│       └── 2026-02-14-memory-planning.md
```

---

## 5. Implementation Priority

### Phase 1: Identity (1-2 hours)
- [ ] Create bootstrap file templates (SOUL.md, USER.md, MEMORY.md)
- [ ] Inject bootstrap files into system prompt
- [ ] Add setup command: `/setup-identity`

### Phase 2: Session Memory (2-3 hours)
- [ ] Enhance `/done` command to save session summary
- [ ] Generate LLM-based slugs for memory filenames
- [ ] Create memory directory structure

### Phase 3: Memory Search (2-3 hours)
- [ ] Add `memory_search` MCP tool
- [ ] Filter Copilot vector search to memory directory
- [ ] Add memory recall instruction to system prompt

### Phase 4: Polish (optional)
- [ ] Soul switching (like soul-evil hook)
- [ ] Memory management UI
- [ ] Auto-compaction of old memories

---

## 6. Key Differences from OpenClaw

| Aspect | OpenClaw | Obsidian Plugin |
|--------|----------|-----------------|
| Vector DB | Dedicated SQLite + sqlite-vec | Reuse Copilot's Orama index |
| Embedding | OpenAI/Gemini/Local | Copilot's configured provider |
| Storage | `~/.openclaw/workspace/` | `<vault>/.claude/` |
| Session persistence | JSONL transcripts | Claude SDK sessions |
| Multi-agent | Full routing system | Not needed (single user) |

The beauty is: **Huy already has vector search via Copilot integration** - the memory system just needs to:
1. Write memory files to a known location
2. Inject memory recall instructions into system prompt
3. Expose search as a tool Claude can call
