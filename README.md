# OpenAI fast service tiers for Pi

A Pi extension that sets `service_tier` on requests to the `openai` and
`openai-codex` providers. Other providers are left untouched.

## Load

From this directory:

```bash
pi -e ./index.ts --fast
pi -e ./index.ts --ultrafast
```

For permanent loading, add this directory's absolute path to `extensions` in
Pi's settings.json, or run `pi install /absolute/path/to/fast` (the package
manifest exposes only `index.ts`). If already loaded, use `/reload`.

## Commands and flags

| Command | Effect |
| --- | --- |
| `/fast` | Toggle fast → default, or default/ultrafast → fast |
| `/ultrafast` | Toggle ultrafast → default, or default/fast → ultrafast |
| `/fast on` / `/ultrafast on` | Explicitly select that tier |
| `/fast off` / `/ultrafast off` | Disable that tier if selected |
| `/fast status` / `/ultrafast status` | Show the selected tier |

`/fast` and `--fast` send `service_tier: "priority"`; the user-facing mode
name remains `fast`. `/ultrafast` and `--ultrafast` send `"ultrafast"`.

The selected tier is saved in `~/.pi/agent/fast-state.json` (or
`$PI_CODING_AGENT_DIR/fast-state.json`) and restored in following sessions and
on extension reload. This is a user-wide preference shared across projects,
not part of settings or session history. With no saved preference, the tier is
`default`. Enable `/fast on` once to keep fast on until you explicitly disable
it with `/fast off` (or toggle `/fast` again). Ultrafast selections and disabling
also persist; provider and model checks still apply to every request.

`--fast` and `--ultrafast` override the saved startup tier and save the new
selection. If both are present, `--ultrafast` wins. Session changes within the
same extension runtime do not reapply startup flags. Concurrent sessions keep
their own active selection; the last saved change wins for future sessions.
Missing state is normal; invalid/unreadable state falls back to `default` with
a warning. Save failures warn while retaining the selection for the current
session. Writes use atomic file replacement to avoid partial state files.

Commands affect subsequent requests, not requests already in flight. A footer
indicator shows the selection.

## Ultrafast availability and authentication

OpenAI documents Ultrafast for GPT-6 Astra and GPT-6.1 Sol with different access
rules depending on authentication:

- **ChatGPT sign-in (Codex):** Pro $500 (Pro Max / `promax`) and eligible
  Enterprise and Edu workspaces. Pro $100, Pro $200, Plus, and Business do not
  have Ultrafast at launch, even with purchased credits. Workspace permissions
  can also restrict access.
- **API keys:** Ultrafast is available to all API users on supported models,
  subject to API rate limits and pricing. A ChatGPT subscription is not required.

The extension checks only the provider and configured model allowlist locally.
It does **not** decode OAuth tokens, infer entitlement from a plan claim, or
reject API-key authentication. An access token can omit the plan claim even
for a real Pro Max account, and a plan label alone cannot establish workspace
permissions or API access. Missing, opaque, or expired token contents therefore
do not disable the selected tier in this extension.

Pi remains responsible for resolving credentials and refreshing OAuth tokens.
The extension does not resolve or inspect credentials, read auth.json, persist
account information, or query an account endpoint. OpenAI enforces actual
access on every request; selecting Ultrafast does not grant entitlement. If
authentication or access is rejected, the provider error is surfaced normally,
without a silent retry at a different tier.

References:
- [ChatGPT Pro tiers](https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers)
- [Codex speed modes and workspace requirements](https://learn.chatgpt.com/docs/agent-configuration/speed)
- [Ultrafast mode in the API](https://developers.openai.com/api/docs/guides/ultrafast-mode)

## Configure ultrafast models

Add this custom extension setting to Pi's settings.json:

```json
{
  "fast": {
    "ultrafastModels": [
      "gpt-6-astra"
    ]
  }
}
```

To also use `gpt-6.1-sol`, add it to that array; no code change is required.
The default, when the setting is absent, is `["gpt-6-astra"]`. An empty array
disables ultrafast for all models.

Entries are exact, case-sensitive model IDs (covering both supported providers)
or provider-qualified IDs such as `openai-codex/gpt-6-astra`. No wildcards or
prefix matching. The actual request's model ID is checked as well.

The extension reads Pi's effective settings via `pi.getSettings()`, honoring
user/project merging and project trust. User settings normally live at
`~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`); trusted
project settings live at `.pi/settings.json`. Project arrays replace user arrays.
Use `/reload` after editing settings manually.

Enabling `/ultrafast` on an unlisted model is rejected. If a selected ultrafast
model becomes unavailable after a model change, requests use `default` with a
warning; the ultrafast selection stays inactive until an eligible model is
selected again. Invalid allowlist settings also fall back to `default` with a
warning. Fast has no model allowlist. Neither setting grants server-side access.

## How the request hook works / compatibility

Pi AI's OpenAI Responses implementations have a `serviceTier` option, which
serializes to `service_tier`. Extensions can set the wire field directly using
`before_provider_request`: return the replacement payload itself (not a
`{ payload: ... }` wrapper). This extension preserves all other payload fields
and explicitly sends `default` when off, overriding any pre-existing tier.
The hook runs for the Codex SSE and WebSocket paths before transport dispatch.

**Wire values are `default`, `priority` (for fast mode), and `ultrafast`.**
The current [OpenAI Fast mode guide](https://developers.openai.com/api/docs/guides/fast-mode)
and installed OpenAI SDK document both `fast` and `priority`; the SDK explains
that either request value resolves to `priority` for models without a distinct
Fast tier. This extension sends `priority` for `/fast` and `--fast` for
compatibility with endpoints that do not accept `fast`.

Ultrafast is sent only for allowlisted models. Endpoint acceptance and model
availability still depend on server-side access. A rejecting endpoint will
return an API error; there is no silent retry with a different paid tier.

## Usage cost estimates

Pi's built-in tier pricing does not currently recognize Ultrafast. This extension
corrects `usage.cost` on finalized Ultrafast assistant responses before Pi
persists them, so the footer, session usage totals, and exports include the
premium:

| Provider | Ultrafast estimate relative to Standard |
| --- | --- |
| `openai-codex` | **8×**, representing included ChatGPT subscription usage |
| `openai` | **6×**, representing API token pricing |

All cost components (input, output, cache reads, and cache writes) are repriced
from Pi's effective model catalog, including custom prices and long-context
tiers. Existing costs are not multiplied blindly, avoiding double-counting if
Pi or another copy of the extension already applied the premium. Actual token
counts, reasoning counts, and context-window usage remain unchanged.

The returned response tier takes precedence, including an explicit `default`
downgrade. If the response omits the tier, the extension uses the tier recorded
for that response from the outgoing request, not the current toggle. Changing
models or turning Ultrafast off during a response does not reprice that response.
Fast and other tiers retain Pi's own pricing behavior.

These are **estimates**, not an invoice or a modification of OpenAI's reported
account usage. Codex uses 8× to reflect included subscription consumption; paid
credits and eligible Enterprise/Edu usage are charged at 6× instead. Pi does
not expose which allowance is being consumed, so the extension cannot switch
that estimate automatically. See the [speed guide](https://learn.chatgpt.com/docs/agent-configuration/speed)
and [API pricing](https://developers.openai.com/api/docs/pricing).

The correction applies only to new assistant responses observed by this
extension. Historical messages are not repriced. Unmatched responses are left
unchanged. Background cache-warming usage is recorded separately by Pi without
an editable `message_end` hook and is **not** corrected here; compaction,
summaries, and nested-tool usage also retain their own pricing.

## Development

```bash
bun install
bun run check
bun test
```

Tests cover persistent on/off state, startup overrides, storage errors,
flags, mutually exclusive toggles, configuration, model changes,
payload preservation, provider isolation, opaque OAuth tokens, API-key support,
credential changes, and leaving token format, expiry, refresh, and entitlement
to Pi/OpenAI without inspecting credentials or making network requests. Cost
tests cover the 8×/6× premiums, all cost components, long-context rates,
unchanged token counts, in-flight toggles, server-reported downgrades, retries,
and avoiding double-counting.
