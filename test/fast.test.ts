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
    const ctx = {
        model: { provider: "openai", id: "gpt-6-astra" },
        modelRegistry: authMethods,
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
        auth: (value: { oauth?: boolean; token?: string; headers?: Record<string, string>; error?: boolean }) => {
            oauth = value.oauth ?? true;
            token = value.token;
            headers = value.headers;
            authError = value.error ?? false;
        },
        model: async (provider: string, id: string) => {
            Object.assign(ctx.model!, { provider, id });
            await events.get("model_select")!({}, ctx);
        },
        command: (name: string, args = "") => commands.get(name)!(args, ctx),
        request: async (payload: unknown = { model: ctx.model?.id, input: [] }) =>
            events.get("before_provider_request")!({ type: "before_provider_request", payload }, ctx),
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
