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
            // Access-token plan claims are not a reliable entitlement API. Pi handles
            // credentials and refresh; OpenAI enforces subscription/workspace or API access.
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
