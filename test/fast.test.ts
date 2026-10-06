import { afterAll, describe, expect, test } from "bun:test";
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
    let settings = initialSettings;
    let oauth = true;
    let token: string | undefined = jwt();
    let headers: Record<string, string> | undefined;
    let authError = false;
    const pi = {
        on: (name: string, handler: any) => events.set(name, handler),
        registerFlag: () => {},
        getFlag: (name: string) => flags[name],
        getSettings: () => settings,
        registerCommand: (name: string, options: any) => commands.set(name, options.handler),
    } as unknown as ExtensionAPI;
    const ctx = {
        model: { provider: "openai", id: "gpt-6-astra" },
        modelRegistry: {
            isUsingOAuth: () => oauth,
            getApiKeyAndHeaders: async () => {
                if (authError) throw new Error("sensitive-token-details");
                return { ok: true, apiKey: token, headers };
            },
        },
        hasUI: true,
        ui: { notify: (message: string) => notices.push(message), setStatus: () => {} },
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
        ctx, notices,
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
        h.auth({ oauth: false });
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

    test("only exact promax plan is eligible; no guessing from Pro or Pro500 labels", async () => {
        const h = await harness({ ultrafast: true });
        for (const plan of ["free", "plus", "pro", "prolite", "pro500", "enterprise", "ProMax", null]) {
            h.auth({ token: jwt(plan) });
            expect((await h.request()).service_tier).toBe("default");
        }
        h.auth({ token: jwt("promax") });
        expect((await h.request()).service_tier).toBe("ultrafast");
    });

    test("API keys cannot enable ultrafast, even if a separate ChatGPT account exists", async () => {
        const h = await harness({ fast: true });
        h.auth({ oauth: false, token: jwt() });
        await h.command("ultrafast", "on");
        expect(h.notices.at(-1)).toContain("API-key authentication is not eligible");
        expect((await h.request()).service_tier).toBe("priority");
    });

    test("missing, malformed, expired tokens and auth failures fail closed without leaking details", async () => {
        const h = await harness({ ultrafast: true });
        for (const token of [undefined, "opaque-token", "x.invalid-json.x", jwt("promax", 1), jwt("promax", NaN)]) {
            h.auth({ token });
            expect((await h.request()).service_tier).toBe("default");
        }
        h.auth({ error: true });
        expect((await h.request()).service_tier).toBe("default");
        expect(h.notices.join("\n")).not.toContain("sensitive-token-details");
    });

    test("checks active bearer header instead of a conflicting apiKey", async () => {
        const h = await harness({ ultrafast: true });
        h.auth({ token: jwt(), headers: { Authorization: `Bearer ${jwt("plus")}` } });
        expect((await h.request()).service_tier).toBe("default");
        h.auth({ headers: { authorization: `Bearer ${jwt()}` } });
        expect((await h.request()).service_tier).toBe("ultrafast");
        h.auth({ token: jwt(), headers: { Authorization: "Basic not-a-chatgpt-token" } });
        expect((await h.request()).service_tier).toBe("default");
    });

    test("subscription changes are rechecked before each request and off remains usable", async () => {
        const h = await harness({ ultrafast: true });
        h.auth({ token: jwt("pro") });
        expect((await h.request()).service_tier).toBe("default");
        await h.command("ultrafast", "status");
        expect(h.notices.at(-1)).toContain("inactive");
        await h.command("ultrafast", "off");
        expect((await h.request()).service_tier).toBe("default");
        await h.command("fast", "on");
        expect((await h.request()).service_tier).toBe("priority");
    });
});
