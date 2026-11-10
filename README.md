# Hyper Leader

**English** | [简体中文](README.zh-CN.md)

A local-first decision workbench for business owners, powered by the **official DeepSeek Harness (DSH)** runtime. Hyper Protocol separates judgment, execution and assets. The UI implements a supplied workbench reference; this is not an ERP, four separate bots or a general-purpose coding agent.

**This public repository contains application source and operating documentation only.** The four original business-method archives, private protocol snapshot, internal planning/handoff records, credentials, business inputs and runtime data are excluded. A fresh clone can run the UI and basic source management. Domain methods and complete protocol export require separately authorized, version-matched inputs; missing capabilities are not presented as available. Public source visibility is not an overall open-source license grant.

## Quick start

Requires **Node.js 24.9+**, npm and **Python 3.11+**. Engineering verification was performed on Windows with Node 25; other platforms still need their own environment checks.

```sh
npm ci --ignore-scripts
npm run setup
npm run build
npm start
```

Open **http://127.0.0.1:3220**. Windows users can also run `start.cmd`; on macOS/Linux use `bash start.sh`. The server binds only to loopback. Do not expose its port publicly or treat it as a cloud multi-tenant service.

1. Create a company, individual or family workspace, then a matter.
2. In **Settings**, enter a model endpoint, model name and API key authorized for this project. The protocol is **DeepSeek Messages**, not OpenAI Chat Completions. You may explicitly set `HYPER_LEADER_API_KEY`; unrelated projects and the ambient generic `DEEPSEEK_API_KEY` are not imported.
3. Upload authorized documents or manually add a page, website section, RSS feed or file source. Saving does not fetch; **Save and check** starts a read. Body coverage, attachments and eligibility remain separate.
4. Ask a question in the workbench. Request a saved report or use **Create report**; files appear in **Reports and versions** only after they have actually been written.
5. Revisions preserve earlier files. Confirming a version records the local user's acceptance of that version, not professional certification or real-world effectiveness.

Saving settings makes no model request. Analysis sends the required allowed text, sources and methods to the configured provider and may cost money. A connection probe requires explicit confirmation. Step and output limits are not a monetary cap: DSH retries and context compaction can make additional underlying requests.

## Implemented capabilities

- Six pages, the source drawer, reference-based styling and narrow-screen layouts.
- Workspace/matter isolation, SQLite transactions and history, private files and SHA-256 fingerprints.
- Manual source registration, checks, previews, descriptor revisions, refresh, pause, removal and per-matter adoption. A failed refresh does not overwrite the last successful snapshot.
- Bounded page-body, website-link, RSS and attachment discovery. Local/private/reserved destinations and unsafe redirects are rejected. Readable content is not automatically certified as official or applicable.
- PDF, DOCX, XLSX, CSV, TXT and Markdown parsing with originals and locators retained. Scanned, encrypted, partial and over-budget documents are reported honestly.
- With the authorized inputs installed: read-only method caches and on-demand method reading; original market validation/rendering, enterprise condition/window screening, domestic job-report rendering, and international dual scoring/rendering. Original archives and scoring systems are not rewritten.
- Official DSH sessions and restricted `leader_*` tools, actual file writes, cancellation, user questions and recovery. Material/model-context changes fence the next DSH session; historical logs remain preserved.
- Markdown, escaped HTML, complete domain exports, version history, explicit acceptance, actions/feedback and task records using the selected original protocol schema.
- Opt-in, bounded source refresh only while the application runs. No default subscription, automatic model analysis, registration, submission or publishing.

Task records bind actual source-method versions, fingerprints and authorization snapshots. Deterministic script execution and schema validity do not automatically establish domain compliance, human acceptance or real-world success.

## Authorized method inputs

Business methods are not installed as global skills. The application verifies four owner-supplied ZIP archives before creating its own private method cache:

| Domain | Fixed version |
| --- | --- |
| Market | 0.2.0 |
| Enterprise | 0.4.3 |
| Domestic development | 0.19 |
| International AI/family development | 0.4.9 |

The expected private locations are:

```text
30-业务资料库/00-原始材料与研究输入/原始包/
30-业务资料库/00-原始材料与研究输入/来源快照/Hyper-Protocol-v0.2-agent-draft-20261108/
```

Obtain authorized inputs from the project owner and verify versions/hashes against `src/judgment/policy.ts`. The protocol baseline is **HP-0.2-AGENT-DRAFT-20261108 / 0.2-draft**. Inputs are not automatically downloaded, publicly redistributed or replaced with a newer release. Installing this application does not provide external skills, private knowledge bases, accounts or professional services.

## Important limits

- **Dynamic/login pages:** reported as requiring a browser, authentication or another readable copy. No automatic login or verification bypass. Upload an authorized text copy when appropriate.
- **Public search:** disabled by default. Known URLs and official directories remain usable. Settings can enable Bing's public RSS page, which is not a developer API with an availability commitment. Search snippets remain leads, not full-text evidence.
- **Geography:** no Beijing/Fengtai-only whitelist. Sources are selected for the relevant company and jurisdiction, without claiming worldwide completeness or eligibility.
- **Document budgets:** 20 MiB per upload, at most 300 PDF pages, bounded Office decompression/cell counts, rejection or explicit partial coverage. XLSX reads cached values without executing formulas; missing caches are not zero.
- **Removal/pause:** stops later use and affected runs; it does not erase every historical file. Retention, explicit deletion and backup scope need separate handling.
- **Tracking:** process-local, opt-in source refresh, not an OS daemon. The process must stay running. At most five source reads per tick, possibly fewer for a subscription.
- **Exports:** internal domain exports can contain local asset locators or business data. Review permissions and redact before sharing. Uploaded market sources can be host-bound through an `asset_ref`; the model cannot supply arbitrary local paths.

## Preview and verification

`/design-preview` is visibly marked **concept design / sample data**. It is a visual reference, not a real workspace or business result. The ordinary `/` does not seed fake companies, conversations, revenue or scores.

Checks available without the private method archives:

```sh
npm run check
npm run test:public
npm run build
```

The complete regression suite requires the authorized local method archives and protocol snapshot; they are not downloaded from this repository:

```sh
npm test
npm run test:runtime
npm run test:e2e
npm run doctor
```

`test:runtime` drives a real official DSH subprocess and scoped tool bridge against a deterministic local model-protocol fixture, not a paid external model. Browser tests use isolated data and explicitly synthetic responses; actual saved files are checked without claiming business quality. On Windows, browser checks prefer an installed Edge with a temporary isolated profile. `npm run setup:browser` can install Chromium headless shell under `.local/browsers` when needed; it does not download model weights.

Engineering checks, agent screenshot review, upstream regressions, human approval and real-world outcomes are reported separately.

## Private data and configuration

Runtime data defaults to `.local/`. Set `HYPER_LEADER_HOME` to an explicit private directory, `HYPER_LEADER_PORT` to another loopback port, or `HYPER_LEADER_PYTHON` to a compatible interpreter. `.env` files are **not** loaded automatically; copying `.env.example` does not configure the application.

Never commit private data, keys, model sessions or logs. Saved keys are locally encrypted, which helps prevent accidental disclosure but does not protect against control of the same OS account. Known configured credentials are redacted from model views; arbitrary sensitive information is not guaranteed to be detected. See [SECURITY.md](SECURITY.md).

## Repository scope and licensing

The owner authorized public storage of this code. An overall open-source/commercial redistribution license has **not** been selected. `private: true` in `package.json` prevents accidental npm publishing; `UNLICENSED` does not mean the whole project is MIT-licensed. Third-party notices and licenses remain intact: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Internal business documents, source snapshots and raw verification/handoff records remain local. Commit only approved source and documentation; do not bypass private-directory exclusions with `git add -f`.
