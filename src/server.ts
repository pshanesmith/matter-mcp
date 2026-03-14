import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import {
  dbReady,
  formatResults,
  fts5Search,
  normativeSearch,
} from './search.js';

const DEBUG = process.env.MATTER_DEBUG === '1';

function log(msg: string): void {
  if (DEBUG) process.stderr.write(`[matter-mcp:server] ${msg}\n`);
}

const require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'matter_index.db');
const { version } = require('../package.json') as { version: string };

let db: Database.Database;
try {
  db = new Database(DB_PATH, { readonly: true });
} catch {
  // Index hasn't been built yet. Fall back to an in-memory DB so the server
  // starts cleanly; dbReady() returns false and each tool returns a helpful
  // "run npm run build-index" message instead of crashing.
  db = new Database(':memory:');
}

const SPEC_DOCS: Record<string, string> = {
  core: 'Matter Core Specification',
  clusters: 'Matter Application Cluster Specification',
  devices: 'Matter Device Library Specification',
  namespaces: 'Matter Standard Namespaces',
};

const server = new Server(
  { name: 'matter_mcp', version },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'matter_search',
      description:
        'Search the full Matter specification suite using semantic keyword search.\n\n' +
        'Use this for any question about Matter protocol requirements, cluster definitions,\n' +
        'device type requirements, commissioning, security, networking, or other spec topics.\n' +
        'Results include normative language (SHALL/SHOULD/MAY).\n\n' +
        'Parameters:\n' +
        '  - query: Natural language question or keywords\n' +
        "  - doc: Limit to 'core', 'clusters', 'devices', or 'namespaces' (optional)\n" +
        '  - top_k: Number of results (default 5, max 15)\n\n' +
        'Returns markdown-formatted spec excerpts with source, section, and page references.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              "Natural language question or keyword search. E.g. 'mandatory attributes for Door Lock cluster', 'commissioning flow BLE', 'OTA update requestor SHALL'",
            minLength: 2,
            maxLength: 500,
          },
          doc: {
            type: 'string',
            description:
              "Limit search to one spec document. One of: 'core', 'clusters', 'devices', 'namespaces'. Omit to search all.",
            enum: ['core', 'clusters', 'devices', 'namespaces'],
          },
          top_k: {
            type: 'integer',
            description: 'Number of results to return (1–15).',
            minimum: 1,
            maximum: 15,
            default: 5,
          },
        },
        required: ['query'],
      },
      annotations: {
        title: 'Search Matter Specification',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: 'matter_cluster_lookup',
      description:
        'Look up a specific Matter cluster from the Application Cluster Specification.\n\n' +
        'Retrieves cluster attributes, commands, events, feature map, and constraints.\n' +
        'Find mandatory vs optional attributes, command formats, and access control requirements.\n\n' +
        'Parameters:\n' +
        "  - cluster_name: Cluster name (e.g. 'Door Lock', 'Thermostat')\n" +
        "  - aspect: Focus on 'attributes', 'commands', 'events', 'feature_map', 'constraints', or 'access' (optional)\n\n" +
        'Returns cluster definition excerpts with normative requirements.',
      inputSchema: {
        type: 'object',
        properties: {
          cluster_name: {
            type: 'string',
            description:
              "Matter cluster name. E.g. 'Door Lock', 'On/Off', 'Thermostat', 'Basic Information', 'OTA Software Update Requestor'",
            minLength: 2,
            maxLength: 100,
          },
          aspect: {
            type: 'string',
            description:
              "Specific aspect to focus on: 'attributes', 'commands', 'events', 'feature_map', 'constraints', 'access'. Omit for full overview.",
            enum: [
              'attributes',
              'commands',
              'events',
              'feature_map',
              'constraints',
              'access',
            ],
          },
        },
        required: ['cluster_name'],
      },
      annotations: {
        title: 'Look Up Matter Cluster Definition',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: 'matter_device_type_lookup',
      description:
        'Look up required and optional clusters for a Matter device type.\n\n' +
        'Find which clusters are mandatory (M), optional (O), or conditionally required (C) per the Device Library.\n\n' +
        'Parameters:\n' +
        "  - device_type: Device type name (e.g. 'Door Lock', 'Dimmable Light')\n\n" +
        'Returns device type definition with required cluster list.',
      inputSchema: {
        type: 'object',
        properties: {
          device_type: {
            type: 'string',
            description:
              "Matter device type. E.g. 'Door Lock', 'Dimmable Light', 'Thermostat', 'Bridge', 'Generic Switch'",
            minLength: 2,
            maxLength: 100,
          },
        },
        required: ['device_type'],
      },
      annotations: {
        title: 'Look Up Matter Device Type Requirements',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: 'matter_tag_lookup',
      description:
        'Look up semantic tags from the Matter Standard Namespaces specification.\n\n' +
        'Use when building a TagList for endpoints, rooms, landmarks, or device-specific\n' +
        'namespaces. Returns namespace IDs, tag values, and notation guidance.\n\n' +
        'Parameters:\n' +
        "  - query: Tag namespace or name (e.g. 'Common Area', 'kitchen', 'Closure')\n\n" +
        'Returns matching tag definitions with namespace IDs and preferred notation.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              "Semantic tag namespace or tag name. E.g. 'Common Area', 'Landmark', 'Closure', 'kitchen', 'Switches'",
            minLength: 1,
            maxLength: 100,
          },
        },
        required: ['query'],
      },
      annotations: {
        title: 'Look Up Matter Semantic Tag',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: 'matter_normative_check',
      description:
        'Search for SHALL/SHOULD/MAY normative requirements on a specific topic.\n\n' +
        'Useful for compliance checking: find exactly what the spec mandates vs recommends\n' +
        'vs permits. Results are re-ranked to prioritize chunks containing normative language.\n\n' +
        'Parameters:\n' +
        '  - query: Natural language question or keywords\n' +
        "  - doc: Limit to 'core', 'clusters', 'devices', or 'namespaces' (optional)\n" +
        '  - top_k: Number of results (default 5, max 15)\n\n' +
        'Returns spec excerpts emphasizing normative requirements.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              "Natural language question or keyword search. E.g. 'mandatory attributes for Door Lock cluster', 'commissioning flow BLE', 'OTA update requestor SHALL'",
            minLength: 2,
            maxLength: 500,
          },
          doc: {
            type: 'string',
            description:
              "Limit search to one spec document. One of: 'core', 'clusters', 'devices', 'namespaces'. Omit to search all.",
            enum: ['core', 'clusters', 'devices', 'namespaces'],
          },
          top_k: {
            type: 'integer',
            description: 'Number of results to return (1–15).',
            minimum: 1,
            maximum: 15,
            default: 5,
          },
        },
        required: ['query'],
      },
      annotations: {
        title: 'Check Matter Normative Requirements',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: 'matter_index_status',
      description:
        'Check whether the Matter spec index is built and ready.\n\n' +
        'Returns index stats including chunk counts per document.\n\n' +
        'Parameters:\n' +
        '  - verbose: Show per-document chunk counts (default false)\n\n' +
        'Returns index status summary.',
      inputSchema: {
        type: 'object',
        properties: {
          verbose: {
            type: 'boolean',
            description: 'Show per-document chunk counts.',
            default: false,
          },
        },
      },
      annotations: {
        title: 'Check Matter Index Status',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  ],
}));

const VALID_DOCS = new Set(['core', 'clusters', 'devices', 'namespaces']);

let dbReadyCache: boolean | null = null;

function isDbReady(): boolean {
  if (dbReadyCache !== null) return dbReadyCache;
  dbReadyCache = dbReady(db);
  return dbReadyCache;
}

/** Extract and validate a required string argument */
function requireString(
  args: Record<string, unknown> | undefined,
  key: string,
): string {
  const val = args?.[key];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Missing or invalid required argument: '${key}'`);
  }
  return val;
}

/** Validate and clamp top_k to [1, 15] */
function parseTopK(args: Record<string, unknown> | undefined): number {
  const raw = (args?.top_k as number | undefined) ?? 5;
  return Math.max(1, Math.min(15, raw));
}

/** Validate optional doc filter against known doc keys */
function parseDocFilter(
  args: Record<string, unknown> | undefined,
): string | null {
  const doc = (args?.doc as string | undefined) ?? null;
  if (doc !== null && !VALID_DOCS.has(doc)) {
    throw new Error(
      `Invalid doc filter: '${doc}'. Must be one of: ${[...VALID_DOCS].join(', ')}`,
    );
  }
  return doc;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  log(`tool=${name} args=${JSON.stringify(args)}`);

  const notReady =
    '⚠️ Matter spec index not built yet.\n\nRun `npm run build-index` first to index the PDF specs.';

  switch (name) {
    case 'matter_search': {
      if (!isDbReady()) return { content: [{ type: 'text', text: notReady }] };
      const query = requireString(args, 'query');
      const doc = parseDocFilter(args);
      const topK = parseTopK(args);
      const results = fts5Search(query, doc, topK, db);
      return {
        content: [{ type: 'text', text: formatResults(results, query) }],
      };
    }

    case 'matter_cluster_lookup': {
      if (!isDbReady()) return { content: [{ type: 'text', text: notReady }] };
      const clusterName = requireString(args, 'cluster_name');
      const aspect = args?.aspect as string | undefined;
      const query = aspect ? `${clusterName} ${aspect}` : clusterName;
      const results = fts5Search(query, 'clusters', 8, db);
      const label = `Cluster: ${clusterName}${aspect ? ` [${aspect}]` : ''}`;
      return {
        content: [{ type: 'text', text: formatResults(results, label) }],
      };
    }

    case 'matter_device_type_lookup': {
      if (!isDbReady()) return { content: [{ type: 'text', text: notReady }] };
      const deviceType = requireString(args, 'device_type');
      const results = fts5Search(deviceType, 'devices', 6, db);
      return {
        content: [
          {
            type: 'text',
            text: formatResults(results, `Device Type: ${deviceType}`),
          },
        ],
      };
    }

    case 'matter_tag_lookup': {
      if (!isDbReady()) return { content: [{ type: 'text', text: notReady }] };
      const query = requireString(args, 'query');
      const results = fts5Search(query, 'namespaces', 6, db);
      return {
        content: [
          { type: 'text', text: formatResults(results, `Tag: ${query}`) },
        ],
      };
    }

    case 'matter_normative_check': {
      if (!isDbReady()) return { content: [{ type: 'text', text: notReady }] };
      const query = requireString(args, 'query');
      const doc = parseDocFilter(args);
      const topK = parseTopK(args);
      const results = normativeSearch(query, doc, topK, db);
      return {
        content: [
          {
            type: 'text',
            text: formatResults(results, `Normative requirements: ${query}`),
          },
        ],
      };
    }

    case 'matter_index_status': {
      try {
        const total = (
          db.prepare('SELECT COUNT(*) as n FROM chunks_fts').get() as {
            n: number;
          }
        ).n;
        if (total === 0) {
          return {
            content: [
              {
                type: 'text',
                text: '❌ Index exists but is empty. Run `npm run build-index`.',
              },
            ],
          };
        }
        const lines = [
          `✅ Matter spec index ready — ${total.toLocaleString()} chunks indexed\n`,
        ];
        const verbose = (args?.verbose as boolean | undefined) ?? false;
        if (verbose) {
          lines.push('**Per-document breakdown:**');
          const rows = db
            .prepare(
              'SELECT doc_key, COUNT(*) as cnt FROM chunks_fts GROUP BY doc_key',
            )
            .all() as Array<{ doc_key: string; cnt: number }>;
          for (const row of rows) {
            const label = SPEC_DOCS[row.doc_key] ?? row.doc_key;
            lines.push(`- ${label}: ${row.cnt.toLocaleString()} chunks`);
          }
        }
        lines.push(`\nIndex location: \`${DB_PATH}\``);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (_e) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Index not built. Run \`npm run build-index\`.\n\nExpected: ${DB_PATH}`,
            },
          ],
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`matter-mcp running — index: ${DB_PATH}`);
