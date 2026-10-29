# @pipeworx/eu-cellar

Every document the Publications Office of the European Union has issued —
Official Journal acts, treaties, consolidated texts, COM proposals and Court of
Justice judgments — searchable by title and readable by CELEX number, from the
CELLAR semantic repository's public SPARQL endpoint.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `cellar_search_works(query, resource_type?, since?, until?, limit?)` — full-text
  title search across every EU resource type; returns CELEX, date, resource type
  and a direct EUR-Lex link.
- `cellar_work(celex? | cellar_id?)` — one document's catalogue entry: every
  English title, document date, in-force flag, resource types, EuroVoc subject
  concepts with English labels, authoring bodies.
- `cellar_sparql(query, limit?)` — your own SELECT or ASK against the repository.
  Writes are refused; results are capped.

## Auth

Keyless. No registration, no key, no published quota.

## Relationship to the `eur-lex` pack

Both talk to publications.europa.eu and they are not duplicates. `eur-lex` is a
curated legal-compliance surface: a hand-kept index of ~14 named acts (GDPR, AI
Act, DORA…), article-level text extraction and CJEU judgment lookup, with its
SPARQL use hard-wired to legislation. This pack is the repository itself —
all resource types, plus an arbitrary SELECT-only query tool.

Use `eur-lex` for "what does GDPR Article 17 say". Use this for "what has the EU
published about X" and for graph questions nobody wrote a tool for.

## Data sources

- <https://publications.europa.eu/webapi/rdf/sparql> — the CELLAR SPARQL
  endpoint (Virtuoso), serving the Common Data Model (`cdm:`) graph.
- <http://publications.europa.eu/resource/cellar/{id}> — the Work URIs the
  endpoint returns.

## Traps, all verified live 2026-09-17

- **Full text needs `bif:contains`, not `FILTER(CONTAINS(...))`.** The endpoint
  is Virtuoso; a `CONTAINS` filter over `?title` scans every expression in the
  repository and times out. The full-text form is
  `?title bif:contains "'phrase'"` — note the INNER single quotes, which
  Virtuoso requires for a multi-word phrase.
- **CELEX literals are typed.** `?w cdm:resource_legal_id_celex "32024R1689"`
  matches nothing; it needs `^^xsd:string`. This is a clean HTTP 200 with zero
  rows, not an error.
- **Titles come back both with and without a language tag.** Filtering on
  `lang(?title) = "en"` silently drops a large share of the repository. Filter
  on the expression's language URI instead — that is the modelled fact.
- **One Work returns many rows.** The (title × type × subject × author) cross
  product means a single document legitimately comes back as 20 bindings.
  `cellar_work` collapses them; hand-written SPARQL will not.
- **`format=` is a query parameter.** The `Accept` header alone is honoured
  inconsistently and you can get RDF/XML where you asked for JSON.
- **A malformed query is HTTP 200 with an HTML error page.** Parsed naively that
  reads as "no results". This pack raises it as a rejected query.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "eu-cellar": {
      "url": "https://gateway.pipeworx.io/eu-cellar/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/eu-cellar/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/cellar_search_works \
  -H 'Content-Type: application/json' \
  -d '{"query":"carbon border adjustment","limit":4}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/cellar_search_works`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-eu-cellar` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/eu-cellar/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "eu-cellar": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-eu-cellar"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Eu Cellar data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
