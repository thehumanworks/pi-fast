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
also persist; eligibility checks still apply to every request.

`--fast` and `--ultrafast` override the saved startup tier and save the new
selection. If both are present, `--ultrafast` wins. Session changes within the
same extension runtime do not reapply startup flags. Concurrent sessions keep
their own active selection; the last saved change wins for future sessions.
Missing state is normal; invalid/unreadable state falls back to `default` with
a warning. Save failures warn while retaining the selection for the current
session. Writes use atomic file replacement to avoid partial state files.

Commands affect subsequent requests, not requests already in flight. A footer
indicator shows the selection.

## Subscription eligibility

Ultrafast requires **both** an allowlisted model and ChatGPT OAuth authentication
whose active token reports the exact plan `promax` (Pro Max, referred to here as
Pro500). Ordinary `pro`, `prolite`, Plus, enterprise plans, and API keys are not
eligible. The literal claim `pro500` is not treated as an alias: the upstream
plan identifier is `promax`.

The extension resolves the selected model's credentials through Pi's
`ctx.modelRegistry`, allowing Pi to refresh OAuth credentials normally, and
locally reads `https://api.openai.com/auth.chatgpt_plan_type` from the JWT payload
(the namespace is an object key, not a URL the extension calls). It does not
read a separate auth.json, log tokens, persist account information, or query an
undocumented account endpoint. Eligibility is rechecked before every ultrafast
request, so changing accounts or plans cannot leave a stale eligible result.

Missing/unreadable claims, opaque or expired tokens, API-key authentication,
and auth-resolution errors **fail closed**: `/ultrafast` cannot be enabled, and
an existing selection or `--ultrafast` uses `default` with a warning. `/fast`
remains available and `/ultrafast off` always allows disabling the selection.
The commands and CLI flag remain registered so ineligible users get an
explanation rather than an unknown-command error.

**Detection limitation:** OpenAI's Codex source defines `promax` separately and
reads the plan claim from its **ID token**. Pi does not retain that ID token.
This extension can detect the plan only if the resolved **access token** also
exposes the claim. A real Pro Max account with no readable access-token plan
claim will therefore remain blocked; there is intentionally no manual bypass.
JWT decoding is a local eligibility hint, not signature verification or proof
of server-side entitlement. OpenAI still enforces access, and claims can lag a
subscription change until the token refreshes.

References checked:
- [Codex plan identifiers](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/auth.rs)
- [Codex JWT plan claims](https://github.com/openai/codex/blob/main/codex-rs/login/src/token_data.rs)

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

When `gpt-6.1-sol` is enabled by your endpoint, add it to that array; no code
change is required. The default, when the setting is absent, is
`["gpt-6-astra"]`. An empty array disables ultrafast for all models.

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

Ultrafast behavior and eligibility checks are unchanged. Endpoint acceptance
and model availability still depend on server-side access. A rejecting endpoint
will return an API error; there is no silent retry with a different paid tier.

Pi's existing service-tier cost adjustments recognize `priority`/`flex`, but
ultrafast cost estimates may not reflect actual billing. Check actual
availability and billing with your endpoint.

## Development

```bash
bun install
bun run check
bun test
```

Tests cover persistent on/off state, startup overrides, storage errors,
flags, mutually exclusive toggles, configuration, model changes,
payload preservation, provider isolation, Pro Max eligibility, credential
changes, API-key rejection, malformed/expired tokens, and safe auth-error
handling without making network requests.
