import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

type Tier = "default" | "fast" | "ultrafast";

const DEFAULT_ULTRAFAST_MODELS = ["gpt-6-astra"];
const OPENAI_PROVIDERS = new Set(["openai", "openai-codex"]);

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Local eligibility hint only, not JWT signature verification or server authorization.
function tokenPlan(token: string | undefined): string | undefined {
    try {
        const parts = token?.split(".");
        if (parts?.length !== 3 || !parts[1]) return undefined;
        const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        if (!isObject(claims)) return undefined;
        if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) return undefined;
        const auth = claims["https://api.openai.com/auth"];
        return isObject(auth) && typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined;
    } catch {
        return undefined;
    }
}

async function subscriptionReason(ctx: ExtensionContext): Promise<string | undefined> {
    const required = "Ultrafast requires a ChatGPT Pro Max (promax / Pro500) subscription.";
    try {
        if (!ctx.model || !ctx.modelRegistry.isUsingOAuth(ctx.model)) return `${required} API-key authentication is not eligible.`;
        // Resolve the active model's auth through Pi (including OAuth refresh), not a separate auth.json file.
        const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
        if (!resolved.ok) return `${required} Could not determine the active subscription.`;
        const authorization = Object.entries(resolved.headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
        const bearer = typeof authorization === "string" ? /^Bearer\s+(.+)$/i.exec(authorization)?.[1] : undefined;
        const plan = tokenPlan(authorization !== undefined ? bearer : resolved.apiKey);
        if (plan === "promax") return undefined;
        return plan === undefined
            ? `${required} The active OAuth token does not expose a readable, unexpired plan claim; ultrafast is disabled.`
            : `${required} The active subscription is not Pro Max.`;
    } catch {
        // Never surface auth errors: they can contain tokens or other credential details.
        return `${required} Could not determine the active subscription.`;
    }
}

export default function fastExtension(pi: ExtensionAPI): void {
    // User-wide preference, separate from settings and conversation history.
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    const statePath = join(agentDir.startsWith("~/") ? join(homedir(), agentDir.slice(2)) : agentDir, "fast-state.json");
    let selected: Tier = "default";
    let initialized = false;
    let lastWarning: string | undefined;

    function storageWarning(ctx: ExtensionContext, message: string): void {
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else console.error(`[fast] ${message}`);
    }

    function loadSelection(ctx: ExtensionContext): Tier {
        try {
            const state: unknown = JSON.parse(readFileSync(statePath, "utf8"));
            if (!isObject(state) || (state.selected !== "default" && state.selected !== "fast" && state.selected !== "ultrafast")) {
                throw new Error("Invalid saved tier");
            }
            return state.selected;
        } catch (error) {
            if (!isObject(error) || error.code !== "ENOENT") {
                storageWarning(ctx, `Could not read the saved fast preference at ${statePath}. Using the default tier.`);
            }
            return "default";
        }
    }

    function saveSelection(ctx: ExtensionContext): void {
        const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
        try {
            mkdirSync(dirname(statePath), { recursive: true });
            writeFileSync(temporaryPath, `${JSON.stringify({ selected })}\n`, { mode: 0o600, flag: "wx" });
            // Atomic replacement keeps other sessions from reading partial JSON.
            renameSync(temporaryPath, statePath);
        } catch {
            storageWarning(ctx, `Could not save the fast preference at ${statePath}. The selection applies only to this session.`);
        } finally {
            try { rmSync(temporaryPath, { force: true }); } catch { /* Best-effort cleanup. */ }
        }
    }

    for (const name of ["fast", "ultrafast"] as const) {
        pi.registerFlag(name, {
            description: `Start with the OpenAI ${name} service tier`,
            type: "boolean",
            default: false,
        });
    }

    function ultrafastModels(): string[] {
        const settings: unknown = pi.getSettings();
        const config = isObject(settings) ? settings.fast : undefined;
        if (config === undefined) return DEFAULT_ULTRAFAST_MODELS;
        if (!isObject(config)) throw new Error("settings.fast must be an object");
        const models = config.ultrafastModels;
        if (models === undefined) return DEFAULT_ULTRAFAST_MODELS;
        if (!Array.isArray(models) || !models.every((model) => typeof model === "string" && model.trim().length > 0)) {
            throw new Error("settings.fast.ultrafastModels must be an array of non-empty model IDs");
        }
        return models;
    }

    async function unavailableReason(ctx: ExtensionContext, tier: Tier, modelId = ctx.model?.id): Promise<string | undefined> {
        if (!ctx.model || !OPENAI_PROVIDERS.has(ctx.model.provider)) {
            return "The service tier applies only to the openai and openai-codex providers.";
        }
        if (tier === "ultrafast") {
            try {
                const models = ultrafastModels();
                if (!models.includes(modelId ?? "") && !models.includes(`${ctx.model.provider}/${modelId}`)) {
                    return `Ultrafast is not enabled for ${ctx.model.provider}/${modelId}; configure fast.ultrafastModels in settings.json.`;
                }
            } catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
            return subscriptionReason(ctx);
        }
        return undefined;
    }

    async function updateStatus(ctx: ExtensionContext): Promise<void> {
        if (!ctx.hasUI) return;
        const reason = selected !== "default" ? await unavailableReason(ctx, selected) : undefined;
        ctx.ui.setStatus("openai-service-tier", selected === "default" ? undefined : `${selected}${reason ? " (inactive)" : ""}`);
    }

    function warn(ctx: ExtensionContext, reason: string): void {
        if (reason === lastWarning) return;
        lastWarning = reason;
        if (ctx.hasUI) ctx.ui.notify(`${reason} Using the default tier.`, "warning");
        else console.error(`[fast] ${reason} Using the default tier.`);
    }

    for (const name of ["fast", "ultrafast"] as const) {
        pi.registerCommand(name, {
            description: `Toggle OpenAI ${name} service tier (optional: on, off, status)`,
            handler: async (args, ctx) => {
                const action = args.trim().toLowerCase();
                if (!["", "on", "off", "status"].includes(action)) {
                    ctx.ui.notify(`Usage: /${name} [on|off|status]`, "warning");
                    return;
                }
                if (action === "status") {
                    const reason = selected === "default" ? undefined : await unavailableReason(ctx, selected);
                    ctx.ui.notify(`OpenAI service tier: ${selected}${reason ? ` (inactive: ${reason})` : ""}`, "info");
                    return;
                }
                const next: Tier = action === "off"
                    ? (selected === name ? "default" : selected)
                    : action === "on" ? name : selected === name ? "default" : name;
                if (next !== "default") {
                    const reason = await unavailableReason(ctx, next);
                    if (reason) {
                        ctx.ui.notify(reason, "warning");
                        return;
                    }
                }
                selected = next;
                saveSelection(ctx);
                lastWarning = undefined;
                await updateStatus(ctx);
                ctx.ui.notify(`OpenAI service tier: ${selected}. Applies to subsequent requests.`, "info");
            },
        });
    }

    pi.on("session_start", async (_event, ctx) => {
        // Flags are parsed after the factory runs; apply them only at initial startup.
        if (!initialized) {
            selected = loadSelection(ctx);
            if (pi.getFlag("ultrafast") === true || pi.getFlag("fast") === true) {
                selected = pi.getFlag("ultrafast") === true ? "ultrafast" : "fast";
                saveSelection(ctx);
            }
            initialized = true;
        }
        lastWarning = undefined;
        if (selected !== "default") {
            const reason = await unavailableReason(ctx, selected);
            if (reason) warn(ctx, reason);
        }
        await updateStatus(ctx);
    });

    pi.on("model_select", async (_event, ctx) => {
        lastWarning = undefined;
        if (selected !== "default") {
            const reason = await unavailableReason(ctx, selected);
            if (reason) warn(ctx, reason);
        }
        await updateStatus(ctx);
    });

    pi.on("before_provider_request", async (event, ctx) => {
        if (!ctx.model || !OPENAI_PROVIDERS.has(ctx.model.provider) || !isObject(event.payload)) return;
        // Prefer the wire model ID: it may differ from the selected catalog entry.
        const modelId = typeof event.payload.model === "string" ? event.payload.model : ctx.model.id;
        const reason = selected === "default" ? undefined : await unavailableReason(ctx, selected, modelId);
        if (reason) warn(ctx, reason);
        else lastWarning = undefined;
        if (ctx.hasUI) {
            ctx.ui.setStatus("openai-service-tier", selected === "default" ? undefined : `${selected}${reason ? " (inactive)" : ""}`);
        }
        // The hook returns the replacement payload itself, not { payload: ... }.
        // /fast is the user-facing mode; priority is its compatible wire value.
        const serviceTier = reason ? "default" : selected === "fast" ? "priority" : selected;
        return { ...event.payload, service_tier: serviceTier };
    });
}
