import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDirs: string[] = [];
function stateDirectory(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-fast-test-"));
    stateDirs.push(dir);
    return dir;
}
afterAll(() => stateDirs.forEach(dir => rmSync(dir, { recursive: true, force: true })));
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fastExtension from "../index.ts";
import type { AssistantMessage, ModelCost } from "@earendil-works/pi-ai";

function jwt(plan: unknown = "promax", exp = Math.floor(Date.now() / 1000) + 3600): string {
    const payload = { exp, "https://api.openai.com/auth": { chatgpt_plan_type: plan } };
    return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

async function harness(flags: Record<string, boolean> = {}, initialSettings: unknown = {}, stateDir = stateDirectory()) {
    const events = new Map<string, (event: any, ctx: ExtensionContext) => any>();
    const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
    const notices: string[] = [];
    const statuses: (string | undefined)[] = [];
    let settings = initialSettings;
    let oauth = true;
    let token: string | undefined = "opaque-oauth-token";
    let headers: Record<string, string> | undefined;
    let authError = false;
    const authMethods = {
        isUsingOAuth: mock(() => oauth),
        getApiKeyAndHeaders: mock(async () => {
            if (authError) throw new Error("sensitive-token-details");
            return { ok: true, apiKey: token, headers };
        }),
    };
    const pi = {
        on: (name: string, handler: any) => events.set(name, handler),
        registerFlag: () => {},
        getFlag: (name: string) => flags[name],
        getSettings: () => settings,
        registerCommand: (name: string, options: any) => commands.set(name, options.handler),
    } as unknown as ExtensionAPI;
    let modelCost: ModelCost = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
    const ctx = {
        model: { provider: "openai", id: "gpt-6-astra", api: "openai-responses" },
        modelRegistry: {
            ...authMethods,
            find: (provider: string, id: string) => ["gpt-6-astra", "gpt-6.1-sol"].includes(id)
                ? { provider, id, cost: modelCost } : undefined,
        },
        hasUI: true,
        ui: {
            notify: (message: string) => notices.push(message),
            setStatus: (_key: string, value: string | undefined) => statuses.push(value),
        },
    } as unknown as ExtensionCommandContext;
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        process.env.PI_CODING_AGENT_DIR = stateDir;
        fastExtension(pi);
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    await events.get("session_start")!({}, ctx);
    return {
        ctx, notices, statuses, authMethods,
        restartSession: () => events.get("session_start")!({}, ctx),
        settings: (value: unknown) => { settings = value; },
        prices: (value: ModelCost) => { modelCost = value; },
        auth: (value: { oauth?: boolean; token?: string; headers?: Record<string, string>; error?: boolean }) => {
            oauth = value.oauth ?? true;
            token = value.token;
            headers = value.headers;
            authError = value.error ?? false;
        },
        model: async (provider: string, id: string) => {
            Object.assign(ctx.model!, { provider, id, api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses" });
            await events.get("model_select")!({}, ctx);
        },
        command: (name: string, args = "") => commands.get(name)!(args, ctx),
        request: async (payload: unknown = { model: ctx.model?.id, input: [] }) =>
            events.get("before_provider_request")!({ type: "before_provider_request", payload }, ctx),
        stream: (data: unknown, provider = ctx.model!.provider, model = ctx.model!.id) =>
            events.get("provider_stream_event")?.({ type: "provider_stream_event", provider, model, api: ctx.model?.api, data }, ctx),
        end: async <T>(message: T): Promise<T> =>
            (await events.get("message_end")?.({ type: "message_end", message }, ctx))?.message ?? message,
    };
}

describe("OpenAI service tiers", () => {
    test("fast persists across extension instances, and off persists too", async () => {
        const dir = stateDirectory();
        const first = await harness({}, {}, dir);
        await first.command("fast", "on");
        expect(JSON.parse(readFileSync(join(dir, "fast-state.json"), "utf8"))).toEqual({ selected: "fast" });
        const second = await harness({}, {}, dir);
        expect((await second.request()).service_tier).toBe("priority");
        await second.command("fast", "off");
        const third = await harness({}, {}, dir);
        expect((await third.request()).service_tier).toBe("default");
    });

    test("startup flags override and persist; session changes do not reapply flags", async () => {
        const dir = stateDirectory();
        const first = await harness({ fast: true }, {}, dir);
        expect((await (await harness({}, {}, dir)).request()).service_tier).toBe("priority");
        await first.command("fast", "off");
        await first.restartSession();
        expect((await first.request()).service_tier).toBe("default");
        await harness({ fast: true, ultrafast: true }, {}, dir);
        expect((await (await harness({}, {}, dir)).request()).service_tier).toBe("ultrafast");
    });

    test("status, invalid commands, and rejected selections do not overwrite saved state", async () => {
        const dir = stateDirectory();
        const h = await harness({ fast: true }, {}, dir);
        const saved = readFileSync(join(dir, "fast-state.json"), "utf8");
        await h.command("fast", "status");
        await h.command("fast", "invalid");
        h.settings({ fast: { ultrafastModels: [] } });
        await h.command("ultrafast", "on");
        expect(readFileSync(join(dir, "fast-state.json"), "utf8")).toBe(saved);
    });

    test("corrupt saved state warns and falls back to default", async () => {
        for (const contents of ["not JSON", '{"selected":"unknown"}', "null"]) {
            const dir = stateDirectory();
            writeFileSync(join(dir, "fast-state.json"), contents);
            const h = await harness({}, {}, dir);
            expect((await h.request()).service_tier).toBe("default");
            expect(h.notices[0]).toContain("Could not read");
        }
    });

    test("save failures warn without preventing session-local toggles", async () => {
        const dir = stateDirectory();
        const blocked = join(dir, "not-a-directory");
        writeFileSync(blocked, "blocked");
        const h = await harness({}, {}, blocked);
        await h.command("fast", "on");
        expect((await h.request()).service_tier).toBe("priority");
        expect(h.notices.join("\n")).toContain("Could not save");
    });

    test("defaults to default and preserves payload without mutation", async () => {
        const h = await harness();
        const payload = { model: "gpt-6-astra", input: ["hello"], service_tier: "auto" };
        expect(await h.request(payload)).toEqual({ ...payload, service_tier: "default" });
        expect(payload.service_tier).toBe("auto");
    });

    test("CLI flags select tier; ultrafast takes precedence", async () => {
        expect((await (await harness({ fast: true })).request()).service_tier).toBe("priority");
        expect((await (await harness({ ultrafast: true })).request()).service_tier).toBe("ultrafast");
        expect((await (await harness({ fast: true, ultrafast: true })).request()).service_tier).toBe("ultrafast");
    });

    test("commands toggle and replace each other", async () => {
        const h = await harness();
        await h.command("fast");
        expect((await h.request()).service_tier).toBe("priority");
        await h.command("ultrafast");
        expect((await h.request()).service_tier).toBe("ultrafast");
        await h.command("ultrafast");
        expect((await h.request()).service_tier).toBe("default");
        await h.command("fast", "on");
        await h.command("fast", "on");
        await h.command("ultrafast", "off");
        expect((await h.request()).service_tier).toBe("priority");
        await h.command("fast", "off");
        expect((await h.request()).service_tier).toBe("default");
    });

    test("unsupported ultrafast is rejected; model changes suspend it", async () => {
        const h = await harness({ ultrafast: true });
        await h.model("openai", "gpt-6.1-sol");
        expect((await h.request()).service_tier).toBe("default");
        await h.command("ultrafast", "on");
        expect(h.notices.at(-1)).toContain("not enabled");
        await h.model("openai-codex", "gpt-6-astra");
        expect((await h.request()).service_tier).toBe("ultrafast");
    });

    test("configurable bare and provider-qualified model IDs, empty list", async () => {
        const h = await harness({ ultrafast: true }, { fast: { ultrafastModels: ["openai/gpt-6.1-sol"] } });
        await h.model("openai", "gpt-6.1-sol");
        expect((await h.request()).service_tier).toBe("ultrafast");
        await h.model("openai-codex", "gpt-6.1-sol");
        expect((await h.request()).service_tier).toBe("default");
        h.settings({ fast: { ultrafastModels: ["gpt-6.1-sol"] } });
        expect((await h.request()).service_tier).toBe("ultrafast");
        h.settings({ fast: { ultrafastModels: [] } });
        expect((await h.request()).service_tier).toBe("default");
    });

    test("invalid settings fail closed with warning", async () => {
        const h = await harness({ ultrafast: true }, { fast: { ultrafastModels: "*" } });
        expect((await h.request()).service_tier).toBe("default");
        expect(h.notices[0]).toContain("must be an array");
    });

    test("checks actual payload model and ignores unrelated providers/payloads", async () => {
        const h = await harness({ ultrafast: true });
        expect((await h.request({ model: "other-model" })).service_tier).toBe("default");
        expect(await h.request(null)).toBeUndefined();
        expect(await h.request([])).toBeUndefined();
        await h.model("anthropic", "claude");
        expect(await h.request()).toBeUndefined();
    });

    test("status and invalid args do not change state", async () => {
        const h = await harness({ fast: true });
        await h.command("fast", "status");
        expect(h.notices.at(-1)).toContain("fast");
        await h.command("fast", "invalid");
        expect(h.notices.at(-1)).toContain("Usage:");
        expect((await h.request()).service_tier).toBe("priority");
    });

    test.each(["openai", "openai-codex"])("opaque OAuth tokens can enable ultrafast on %s", async (provider) => {
        const h = await harness();
        await h.model(provider, "gpt-6-astra");
        await h.command("ultrafast", "on");
        expect((await h.request()).service_tier).toBe("ultrafast");
        expect(h.statuses.at(-1)).toBe("ultrafast");
        await h.command("ultrafast", "status");
        expect(h.notices.at(-1)).toBe("OpenAI service tier: ultrafast");
        expect(h.notices.join("\n")).not.toContain("unexpired plan claim");
        expect(h.authMethods.isUsingOAuth).not.toHaveBeenCalled();
        expect(h.authMethods.getApiKeyAndHeaders).not.toHaveBeenCalled();
    });

    test("subscription entitlement is left to OpenAI, not inferred from token plan claims", async () => {
        const h = await harness({ ultrafast: true });
        for (const plan of ["promax", "pro", "prolite", "pro500", "enterprise", "edu", "plus", "free", null]) {
            h.auth({ token: jwt(plan) });
            expect((await h.request()).service_tier).toBe("ultrafast");
        }
        expect(h.notices).toEqual([]);
        expect(h.authMethods.getApiKeyAndHeaders).not.toHaveBeenCalled();
    });

    test("API keys can select ultrafast without a ChatGPT subscription", async () => {
        const h = await harness({ fast: true });
        h.auth({ oauth: false, token: "sk-test-api-key" });
        await h.command("ultrafast", "on");
        expect((await h.request()).service_tier).toBe("ultrafast");
        expect(h.statuses.at(-1)).toBe("ultrafast");
        expect(h.notices.at(-1)).toContain("OpenAI service tier: ultrafast");
        expect(h.authMethods.isUsingOAuth).not.toHaveBeenCalled();
        expect(h.authMethods.getApiKeyAndHeaders).not.toHaveBeenCalled();
    });

    test("token format and expiry do not block ultrafast; Pi owns credential resolution and refresh", async () => {
        const h = await harness({ ultrafast: true });
        const noPlan = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
        for (const token of [undefined, "opaque-token", "x.invalid-json.x", noPlan, jwt("promax", 1), jwt("promax", NaN)]) {
            h.auth({ token });
            expect((await h.request()).service_tier).toBe("ultrafast");
        }
        h.auth({ error: true });
        await h.restartSession();
        await h.command("ultrafast", "status");
        expect((await h.request()).service_tier).toBe("ultrafast");
        expect(h.authMethods.getApiKeyAndHeaders).not.toHaveBeenCalled();
        expect(h.notices).toEqual(["OpenAI service tier: ultrafast"]);
    });

    test("authorization headers are not inspected or exposed by the extension", async () => {
        const h = await harness({ ultrafast: true });
        h.auth({ token: jwt(), headers: { Authorization: `Bearer ${jwt("plus")}` } });
        expect((await h.request()).service_tier).toBe("ultrafast");
        h.auth({ headers: { authorization: "Bearer opaque-token" } });
        expect((await h.request()).service_tier).toBe("ultrafast");
        h.auth({ token: jwt(), headers: { Authorization: "Basic sensitive-token-details" } });
        expect((await h.request()).service_tier).toBe("ultrafast");
        expect(h.authMethods.getApiKeyAndHeaders).not.toHaveBeenCalled();
        expect(h.notices).toEqual([]);
    });

    test("credential changes preserve the selection; off and fast remain usable", async () => {
        const h = await harness({ ultrafast: true });
        h.auth({ token: jwt("pro") });
        expect((await h.request()).service_tier).toBe("ultrafast");
        h.auth({ oauth: false, token: "sk-test-api-key" });
        expect((await h.request()).service_tier).toBe("ultrafast");
        await h.command("ultrafast", "status");
        expect(h.notices.at(-1)).toBe("OpenAI service tier: ultrafast");
        await h.command("ultrafast", "off");
        expect((await h.request()).service_tier).toBe("default");
        await h.command("fast", "on");
        expect((await h.request()).service_tier).toBe("priority");
    });
});

function assistant(provider = "openai-codex", responseId = "resp_1"): AssistantMessage {
    return {
        role: "assistant", provider, model: "gpt-6-astra",
        api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses",
        responseId, content: [{ type: "text", text: "hello" }], timestamp: 1, stopReason: "stop",
        usage: {
            input: 1000, output: 500, cacheRead: 2000, cacheWrite: 100, reasoning: 100, totalTokens: 3600,
            cost: { input: 0.01, output: 0.025, cacheRead: 0.002, cacheWrite: 0.00125, total: 0.03825 },
        },
    };
}

describe("Ultrafast usage cost estimates", () => {
    test.each([["openai-codex", 8], ["openai", 6]] as const)("%s records standard cost times %i without changing tokens", async (provider, multiplier) => {
        const h = await harness({ ultrafast: true });
        await h.model(provider, "gpt-6-astra");
        await h.request();
        await h.stream({ type: "response.completed", response: { id: "resp_1", service_tier: "ultrafast" } });
        const original = assistant(provider);
        Object.freeze(original.usage.cost);
        Object.freeze(original.usage);
        Object.freeze(original);
        const result = await h.end(original);
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
            expect(result.usage.cost[key]).toBeCloseTo(original.usage.cost[key] * multiplier, 10);
        }
        expect({ ...result.usage, cost: undefined }).toEqual({ ...original.usage, cost: undefined });
        expect(result.content).toEqual(original.content);
        expect(original.usage.cost.total).toBe(0.03825);
        // This is the message Pi persists and uses in its footer/session usage totals.
        expect(JSON.parse(JSON.stringify(result)).usage.cost.total).toBeCloseTo(0.03825 * multiplier, 10);
    });

    test("uses configured catalog rates and long-context pricing, including cached prompt tokens", async () => {
        const h = await harness({ ultrafast: true });
        await h.model("openai-codex", "gpt-6-astra");
        h.prices({
            input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5,
            tiers: [{ inputTokensAbove: 272000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
        });
        await h.request();
        await h.stream({ type: "response.completed", response: { id: "resp_1", service_tier: "ultrafast" } });
        const message = assistant();
        message.usage.input = 270000;
        message.usage.cacheRead = 2001;
        message.usage.totalTokens = 272601;
        const result = await h.end(message);
        expect(result.usage.cost.total).toBeCloseTo((270000 * 20 + 500 * 75 + 2001 * 2 + 100 * 25) / 1000000 * 8, 10);
    });

    test("recalculates instead of compounding native or previously adjusted costs", async () => {
        const h = await harness({ ultrafast: true });
        await h.model("openai-codex", "gpt-6-astra");
        await h.request();
        await h.stream({ type: "response.completed", response: { id: "resp_1", service_tier: "ultrafast" } });
        const message = assistant();
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) message.usage.cost[key] *= 8;
        const first = await h.end(message);
        expect(first.usage.cost.total).toBeCloseTo(0.03825 * 8, 10);
        expect(await h.end(first)).toEqual(first);
    });

    test("uses the sent tier when omitted, even after toggling off and changing models in flight", async () => {
        const h = await harness({ ultrafast: true });
        await h.model("openai-codex", "gpt-6-astra");
        await h.request();
        await h.command("ultrafast", "off");
        await h.stream({ type: "response.created", response: { id: "resp_1" } });
        await h.model("anthropic", "claude");
        expect((await h.end(assistant())).usage.cost.total).toBeCloseTo(0.03825 * 8, 10);
    });

    test.each(["default", "priority", "fast", "flex"])("respects the server's %s tier rather than charging ultrafast", async (tier) => {
        const h = await harness({ ultrafast: true });
        await h.model("openai-codex", "gpt-6-astra");
        await h.request();
        await h.stream({ type: "response.created", response: { id: "resp_1", service_tier: "ultrafast" } });
        await h.stream({ type: "response.completed", response: { id: "resp_1", service_tier: tier } });
        const message = assistant();
        expect(await h.end(message)).toBe(message);
    });

    test("inactive ultrafast selections and fast mode keep Pi's existing costs", async () => {
        const h = await harness({ ultrafast: true }, { fast: { ultrafastModels: [] } });
        await h.model("openai-codex", "gpt-6-astra");
        expect((await h.request()).service_tier).toBe("default");
        await h.stream({ type: "response.completed", response: { id: "resp_1" } });
        const message = assistant();
        expect(await h.end(message)).toBe(message);
        await h.command("fast", "on");
        await h.request();
        await h.stream({ type: "response.completed", response: { id: "resp_2", service_tier: "priority" } });
        const priority = assistant("openai-codex", "resp_2");
        priority.usage.cost.total *= 2;
        expect(await h.end(priority)).toBe(priority);
    });

    test("response IDs keep overlapping replies separate and retries can reuse a request", async () => {
        const h = await harness({ ultrafast: true });
        await h.model("openai-codex", "gpt-6-astra");
        await h.request();
        await h.stream({ type: "response.created", response: { id: "retry" } });
        await h.stream({ type: "response.created", response: { id: "resp_1" } });
        await h.command("ultrafast", "off");
        await h.request();
        await h.stream({ type: "response.created", response: { id: "resp_2" } });
        await h.stream({ type: "response.completed", response: { id: "resp_1" } });
        expect((await h.end(assistant())).usage.cost.total).toBeCloseTo(0.03825 * 8, 10);
        const standard = assistant("openai-codex", "resp_2");
        expect(await h.end(standard)).toBe(standard);
    });

    test.each(["response.done", "response.incomplete", "response.completed"])("handles Codex %s responses and non-stop completions", async (type) => {
        const h = await harness({ ultrafast: true });
        await h.model("openai-codex", "gpt-6-astra");
        await h.request();
        await h.stream({ type, response: { id: "resp_1" } });
        const message = assistant();
        message.stopReason = "length";
        expect((await h.end(message)).usage.cost.total).toBeCloseTo(0.03825 * 8, 10);
    });

    test("zero-usage failures stay zero; unrelated, untracked, and unknown-model messages stay unchanged", async () => {
        const h = await harness({ ultrafast: true });
        await h.model("openai-codex", "gpt-6-astra");
        await h.request();
        const untracked = assistant();
        expect(await h.end(untracked)).toBe(untracked);
        await h.stream({ type: "response.completed", response: { id: "resp_1", service_tier: "ultrafast" } });
        const other = assistant("anthropic");
        expect(await h.end(other)).toBe(other);
        const unknown = { ...assistant(), model: "unknown-model" };
        await h.stream({ type: "response.completed", response: { id: "resp_1", service_tier: "ultrafast" } }, "openai-codex", "unknown-model");
        expect(await h.end(unknown)).toBe(unknown);
        const user = { role: "user", content: "hello", timestamp: 1 };
        expect(await h.end(user)).toBe(user);
        const failure = assistant();
        delete failure.responseId;
        failure.stopReason = "error";
        failure.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
        expect((await h.end(failure)).usage.cost.total).toBe(0);
    });

    test("provider/model identity separates matching response IDs; the reported tier can override the request", async () => {
        const h = await harness();
        await h.model("openai-codex", "gpt-6-astra");
        await h.request();
        await h.stream({ type: "response.completed", response: { id: "resp_1", service_tier: "ultrafast" } });
        await h.model("openai", "gpt-6-astra");
        await h.request();
        await h.stream({ type: "response.completed", response: { id: "resp_1", service_tier: "default" } });
        const api = assistant("openai");
        expect(await h.end(api)).toBe(api);
        expect((await h.end(assistant())).usage.cost.total).toBeCloseTo(0.03825 * 8, 10);
    });

    test("unmatched background responses use bounded bookkeeping and malformed stream events are ignored", async () => {
        const h = await harness({ ultrafast: true });
        await h.model("openai-codex", "gpt-6-astra");
        await h.request();
        for (const data of [null, [], {}, { type: "response.completed" },
            { type: "response.completed", response: { id: 123 } },
            { type: "response.output_text.delta", response: { id: "unrelated", service_tier: "ultrafast" } }]) {
            await h.stream(data);
        }
        for (let i = 0; i < 65; i++) {
            await h.stream({ type: "response.completed", response: { id: `resp_${i}` } });
        }
        const evicted = assistant("openai-codex", "resp_0");
        expect(await h.end(evicted)).toBe(evicted);
        expect((await h.end(assistant("openai-codex", "resp_64"))).usage.cost.total).toBeCloseTo(0.03825 * 8, 10);
    });

    test("a new session drops old response bookkeeping", async () => {
        const h = await harness({ ultrafast: true });
        await h.model("openai-codex", "gpt-6-astra");
        await h.request();
        await h.stream({ type: "response.created", response: { id: "resp_1" } });
        await h.restartSession();
        const old = assistant();
        expect(await h.end(old)).toBe(old);
    });
});
