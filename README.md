# Matter Expert MCP Server

A local MCP server that gives Claude Code expert-level access to the full Matter
specification suite, enabling accurate, spec-grounded answers during firmware development.

## What It Does

When active in Claude Code, you can ask questions like:
- *"What attributes are mandatory for the Door Lock cluster?"*
- *"What clusters does a Thermostat device type require?"*
- *"What's the SHALL requirement for commissioning window timeout?"*
- *"What semantic tags are available for home area locations?"*

Claude Code calls the MCP tools to pull exact spec text and gives you accurate,
normative answers instead of hallucinated ones.

## Tools Available

| Tool | Description |
|------|-------------|
| `matter_search` | Full-text search across all indexed specs |
| `matter_cluster_lookup` | Look up cluster attributes/commands/events |
| `matter_device_type_lookup` | Get required/optional clusters for a device type |
| `matter_tag_lookup` | Look up semantic tags and namespaces |
| `matter_normative_check` | Find SHALL/SHOULD/MAY requirements on a topic |
| `matter_index_status` | Check if index is built and ready |

## Setup

### 1. Install dependencies

```bash
cd matter-mcp
npm install
```

### 2. Place spec PDFs

Create a `pdfs/` subdirectory and copy in your Matter spec PDFs:

```
matter-mcp/
└── pdfs/
    ├── <matter-core-spec>.pdf
    ├── <matter-cluster-spec>.pdf
    ├── <matter-device-library>.pdf
    └── <matter-namespaces>.pdf
```

The indexer auto-detects PDFs by matching these keywords in filenames:
- `core` → Core Specification
- `cluster` → Application Cluster Specification
- `device` → Device Library Specification
- `namespace` → Standard Namespaces

Any PDF whose filename contains the matching keyword (case-insensitive) will be indexed
under that doc key. Update `PDF_KEY_PATTERNS` in `src/build-index.ts` if your
filenames use different conventions.

### 3. Build the index (one-time)

```bash
npm run build-index
```

This takes 2–5 minutes and creates `matter_index.db`. Only needs to be re-run when
you update to a new spec version.

### 4. Register with Claude Code

Add the server to `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "matter": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/matter-mcp/dist/server.js"]
    }
  }
}
```

Replace `/absolute/path/to/matter-mcp/` with the actual path on your machine.

### 5. Use in Claude Code

Restart Claude Code, then test:
```
> Check matter_index_status
> Look up mandatory attributes for the Door Lock cluster
> What does Matter require for OTA update requestors?
```

## Updating to a New Spec Version

1. Replace the PDFs in `pdfs/` with the new versions
2. Re-run `npm run build-index`
3. The old index is replaced automatically

## File Structure

```
matter-mcp/
├── src/
│   ├── server.ts           # MCP server — all 6 tools
│   ├── build-index.ts      # One-time PDF indexer
│   └── search.ts           # FTS5/BM25 search engine
├── dist/                   # Compiled output (run `npm run build`)
├── matter_index.db         # Generated index (after running build-index)
├── package.json
├── tsconfig.json
├── README.md
└── pdfs/                   # Place your spec PDFs here
```
