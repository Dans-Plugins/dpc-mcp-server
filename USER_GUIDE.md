# User Guide

## What this is for

The [DPC Zettelkasten](https://github.com/Dans-Plugins/dpc-zettelkasten) is a
collection of notes about how the Dan's Plugins Community plugins work, where
every claim points at a specific file in a Dans-Plugins repository at a specific
commit. This server puts that collection in front of a model.

The point is not that a model can now answer questions about Medieval Factions.
It could always guess. The point is that the answers arrive **with the citation
attached**, so you can check them.

## Getting started

1. Install Node 18 or later.
2. Clone this repository.
3. Register it with your MCP client — see [README.md](README.md#install).
4. Ask a question.

There is no build step and nothing to configure. A snapshot of the collection is
committed, so it works immediately.

## A first session

Ask something the collection covers:

> How does land ownership work in Medieval Factions?

A well-behaved client will call `search_notes` with something like
`land ownership claim`, find `claimed-chunk` and `demesne-limit`, then call
`get_note` on each. The answer should come back with permalinks like
`https://github.com/Dans-Plugins/Medieval-Factions/blob/3a51c55…/…#L109-L110`.

**If it does not cite anything, be suspicious.** Every concept note in the
collection carries at least one source; an uncited answer is the model
answering from its own priors rather than from the collection.

## What it is good at

**Grounded explanation.** "What is a demesne limit?" gets you the note plus the
two commands that enforce it.

**Structure.** "What does this collection cover?" → `list_maps`. "Which notes
are most connected?" → a `graphql` query. "Which repositories is this grounded
in?" → `get_citations` or `repositories`.

**Checking a claim.** "Is it true that faction power includes vassal power?"
→ `get_citations` for the note, then open the permalink.

**Orientation before code.** Reading `moc-plugin-architecture` before opening
Medieval Factions saves an hour of tracing.

## What it is not

**Not the code.** It describes the code and links to it; it does not contain it.
For the actual source, follow the permalinks.

**Not current by default.** The vendored snapshot is fixed at the commit it was
synced from. Run `npm run sync` to refresh it.

**Not exhaustive.** 45 notes over roughly forty repositories. Absence of a note
means nobody has written one — not that the thing does not exist.

**Not a substitute for the pin.** A citation is true *of the commit it names*.
Code may have moved since; the zettelkasten's own `check_sources.py` reports
drift, and this server does not.

## Writing GraphQL queries

Most questions do not need one. When they do, the schema is in the `graphql`
tool's own description, so a model can usually write a correct query without
asking first. If a query fails, the error comes back with the schema attached —
the usual cause is a guessed field name, and the second attempt succeeds.

```graphql
{ notes(moc: "moc-faction-domain-model", orderBy: degree) { title degree } }
```

See [TOOLS.md](TOOLS.md#graphql) for worked examples.

## Keeping it current

```bash
npm run sync -- --check    # is the vendored copy stale?
npm run sync               # refresh it
```

Restart the server afterwards; the graph is read once at startup.

If you are editing notes yourself, point the server at your checkout with
`DPC_ZK_PATH` instead of syncing — but remember to run `python3 tools/build.py`
in the zettelkasten after each edit, because `site/dataset.json` is generated.

## Troubleshooting

**The client shows no tools.** Check the command path is absolute. Run
`node src/server.js` by hand: it should print a ready line to stderr and then
wait.

**"No zettelkasten data found".** `vendor/` is missing or incomplete. Run
`npm run sync`, or set `DPC_ZK_PATH`.

**Answers with no citations.** Ask directly: "which note is that from, and what
does it cite?" If the model cannot say, it was not using the collection.

**Stale answers.** Check `npm run sync -- --check`.
