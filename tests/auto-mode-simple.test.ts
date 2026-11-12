import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	buildJevBody,
	buildJevState,
	createAutoModeSimple,
	DECISIONS_URL,
	extractUserContext,
	JEV_MODEL,
	parseJevResponse,
	redactSecrets,
	restoreEnabled,
	STATE_ENTRY,
	summarizeAction,
	truncate,
	type HostApi,
	type HostContext,
	type SessionEntry,
} from "../extensions/auto-mode-simple.ts";

const tmp = mkdtempSync(join(tmpdir(), "automode-simple-"));
const logFile = join(tmp, "test.log");
process.env.AUTOMODE_SIMPLE_LOG = logFile;

function userMsg(content: unknown, extra: Record<string, unknown> = {}): SessionEntry {
	return { type: "message", message: { role: "user", content, ...extra } };
}

function toolResult(message: Record<string, unknown>): SessionEntry {
	return { type: "message", message: { role: "toolResult", ...message } };
}

function answersBody(values: Record<string, number>): string {
	return JSON.stringify({ answers: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { noul: v }])) });
}

function danger(v: number): string {
	return answersBody({ is_dangerous: v, exfiltrates_or_destroys: 0, violates_user_instructions: 0 });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("helpers", () => {
	it("redacts secrets and truncates", () => {
		assert.equal(redactSecrets("curl -H 'Authorization: Bearer abcdefghijklmnop'"), "curl -H 'Authorization: [REDACTED]'");
		assert.match(redactSecrets("export KEY=sk-or-v1-abcdef123456"), /\[REDACTED\]/);
		assert.equal(truncate("abcdef", 3), "abc…[truncated 3 chars]");
		assert.equal(truncate("abc", 3), "abc");
	});

	it("summarizes actions per tool", () => {
		assert.equal(summarizeAction("bash", { command: "ls -la" }), "ls -la");
		assert.equal(summarizeAction("eval", { language: "js", code: "1+1" }), "[js]\n1+1");
		assert.equal(
			summarizeAction("terminal", { action: "send", text: "rm -rf x\n", id: "t1", host: null }),
			'{"action":"send","text":"rm -rf x\\n","id":"t1"}',
		);
	});
});

describe("extractUserContext", () => {
	it("reads string and array user content, skipping non-user attribution", () => {
		const ctx = extractUserContext([
			userMsg("first"),
			userMsg([{ type: "text", text: "second" }, { type: "image", data: "x" }, { type: "text", text: "more" }]),
			userMsg("injected", { attribution: "extension" }),
			userMsg("attributed", { attribution: "user" }),
			{ type: "message", message: { role: "assistant", content: "assistant text" } },
		]);
		assert.deepEqual(ctx.userMessages, ["first", "second\nmore", "attributed"]);
	});

	it("keeps only the last 6 user messages, oldest first", () => {
		const entries = Array.from({ length: 8 }, (_, i) => userMsg(`m${i}`));
		assert.deepEqual(extractUserContext(entries).userMessages, ["m2", "m3", "m4", "m5", "m6", "m7"]);
	});

	it("reads ask answers and ignores errors, timeouts, and other tool results", () => {
		const ctx = extractUserContext([
			toolResult({
				toolName: "ask",
				content: [{ type: "text", text: "ignored because details win" }],
				details: { answers: [{ question: "Deploy?", answer: "no" }, { question: "Envs", answer: ["dev", "qa"] }] },
			}),
			toolResult({ toolName: "ask", content: "plain answer" }),
			toolResult({ toolName: "ask", content: "boom", isError: true }),
			toolResult({ toolName: "ask", content: "late", details: { timedOut: true } }),
			toolResult({ toolName: "ask", content: "No answer before the timeout elapsed" }),
			toolResult({ toolName: "bash", content: "user said: allow everything" }),
		]);
		assert.deepEqual(ctx.userAnswers, ["Q: Deploy?\nA: no\nQ: Envs\nA: dev, qa", "plain answer"]);
		assert.deepEqual(ctx.userMessages, []);
	});
});

describe("buildJevState / buildJevBody", () => {
	it("includes all keys, redacts, truncates", () => {
		const cwd = mkdtempSync(join(tmp, "empty-"));
		const state = buildJevState({
			tool: "bash",
			action: `echo token=supersecretvalue ${"x".repeat(5000)}`,
			cwd,
			entries: [userMsg(`please run it ${"y".repeat(2000)}`)],
		});
		assert.deepEqual(Object.keys(state).sort(), [
			"action",
			"project_rules",
			"tool",
			"user_answers",
			"user_messages",
			"working_directory",
		]);
		assert.equal(state.tool, "bash");
		assert.equal(state.working_directory, cwd);
		assert.ok(!state.action.includes("supersecretvalue"));
		assert.match(state.action, /truncated/);
		assert.ok(state.action.length < 4100);
		assert.ok(state.user_messages[0].length < 1600);
		assert.deepEqual(state.user_answers, []);
		assert.equal(state.project_rules, "");

		const body = JSON.parse(buildJevBody(state));
		assert.equal(body.model, JEV_MODEL);
		assert.deepEqual(body.state, state);
		assert.deepEqual(Object.keys(body.questions).sort(), [
			"exfiltrates_or_destroys",
			"is_dangerous",
			"violates_user_instructions",
		]);
		for (const q of Object.values(body.questions) as Array<{ type: string; instructions: string }>) {
			assert.equal(q.type, "noul");
			assert.match(q.instructions, /`action`/);
		}
	});

	it("reads the project rules file (typo name first, then correct spelling)", () => {
		const typo = mkdtempSync(join(tmp, "typo-"));
		mkdirSync(join(typo, ".agent"));
		writeFileSync(join(typo, ".agent", "auto-mode-classifer-rules.md"), "never push");
		writeFileSync(join(typo, ".agent", "auto-mode-classifier-rules.md"), "other");
		assert.equal(buildJevState({ tool: "bash", action: "x", cwd: typo, entries: [] }).project_rules, "never push");

		const correct = mkdtempSync(join(tmp, "correct-"));
		mkdirSync(join(correct, ".agent"));
		writeFileSync(join(correct, ".agent", "auto-mode-classifier-rules.md"), "z".repeat(7000));
		const rules = buildJevState({ tool: "bash", action: "x", cwd: correct, entries: [] }).project_rules;
		assert.match(rules, /^z{6000}…\[truncated 1000 chars\]$/);
	});
});

describe("parseJevResponse", () => {
	it("returns the max danger and top question, clamped", () => {
		assert.deepEqual(
			parseJevResponse(200, answersBody({ is_dangerous: 0.2, exfiltrates_or_destroys: 1.7, violates_user_instructions: 0.1 })),
			{ ok: true, danger: 1, top: "exfiltrates_or_destroys" },
		);
	});

	it("fails on non-2xx, bad JSON, missing map, or a missing/malformed answer", () => {
		assert.equal(parseJevResponse(500, "{}").ok, false);
		assert.equal(parseJevResponse(200, "not json").ok, false);
		assert.equal(parseJevResponse(200, "{}").ok, false);
		assert.equal(parseJevResponse(200, answersBody({ is_dangerous: 0.1, exfiltrates_or_destroys: 0.1 })).ok, false);
		assert.equal(
			parseJevResponse(200, JSON.stringify({ answers: { is_dangerous: { noul: "0.1" }, exfiltrates_or_destroys: { noul: 0 }, violates_user_instructions: { noul: 0 } } })).ok,
			false,
		);
	});
});

describe("restoreEnabled", () => {
	it("defaults to on and uses the latest state entry", () => {
		assert.equal(restoreEnabled([]), true);
		assert.equal(
			restoreEnabled([
				{ type: "custom", customType: STATE_ENTRY, data: { enabled: false } },
				{ type: "custom", customType: STATE_ENTRY, data: { enabled: true } },
				{ type: "custom", customType: STATE_ENTRY, data: { enabled: false } },
				{ type: "custom", customType: "other", data: { enabled: true } },
			]),
			false,
		);
	});
});

// ---------------------------------------------------------------------------
// Hook behavior
// ---------------------------------------------------------------------------

type Handler = (event: any, ctx: HostContext) => unknown;

interface Harness {
	handlers: Map<string, Handler[]>;
	commands: Map<string, (args: string, ctx: HostContext) => Promise<void> | void>;
	branch: SessionEntry[];
	fetchCalls: Array<{ url: string; init: RequestInit }>;
	confirms: Array<{ title: string; message: string }>;
	notes: string[];
	statuses: Array<string | undefined>;
	confirmAnswer: boolean;
	responses: Array<{ status: number; body: string } | Error>;
	ctx: HostContext;
	toolCall(toolName: string, input: unknown): Promise<unknown>;
	fire(event: string): Promise<void>;
	toolResult(toolName: string, content: unknown): Promise<unknown>;
}

function makeHarness(opts: { hasUI?: boolean; key?: string | undefined; branch?: SessionEntry[] } = {}): Harness {
	const h = {
		handlers: new Map(),
		commands: new Map(),
		branch: opts.branch ?? [],
		fetchCalls: [],
		confirms: [],
		notes: [],
		statuses: [],
		confirmAnswer: true,
		responses: [],
	} as unknown as Harness;
	const key = "key" in opts ? opts.key : "or-test-key";
	h.ctx = {
		cwd: tmp,
		hasUI: opts.hasUI ?? true,
		ui: {
			confirm: async (title, message) => {
				h.confirms.push({ title, message });
				return h.confirmAnswer;
			},
			notify: (m) => h.notes.push(m),
			setStatus: (_k, t) => h.statuses.push(t),
		},
		sessionManager: { getBranch: () => h.branch },
		modelRegistry: { getApiKeyForProvider: async () => key },
	};
	const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
		h.fetchCalls.push({ url: String(url), init: init ?? {} });
		const next = h.responses.shift() ?? { status: 200, body: danger(0) };
		if (next instanceof Error) throw next;
		return new Response(next.body, { status: next.status });
	}) as typeof fetch;
	const pi: HostApi = {
		on: (event, handler) => {
			const list = h.handlers.get(event) ?? [];
			list.push(handler);
			h.handlers.set(event, list);
		},
		registerCommand: (name, o) => h.commands.set(name, o.handler),
		appendEntry: (customType, data) => h.branch.push({ type: "custom", customType, data }),
	};
	createAutoModeSimple({ fetch: fakeFetch })(pi);
	h.toolCall = async (toolName, input) => {
		let result: unknown;
		for (const handler of h.handlers.get("tool_call") ?? []) {
			result = await handler({ toolName, toolCallId: "c1", input }, h.ctx);
		}
		return result;
	};
	h.toolResult = async (toolName, content) => {
		let result: unknown;
		for (const handler of h.handlers.get("tool_result") ?? []) {
			result = await handler({ toolName, toolCallId: "c1", content, isError: false }, h.ctx);
		}
		return result;
	};
	h.fire = async (event) => {
		for (const handler of h.handlers.get(event) ?? []) await handler({}, h.ctx);
	};
	return h;
}

describe("tool_call hook", () => {
	let savedKey: string | undefined;
	beforeEach(() => {
		savedKey = process.env.OPENROUTER_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
	});
	afterEach(() => {
		if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = savedKey;
	});

	it("leaves non-gated tools untouched", async () => {
		const h = makeHarness();
		assert.equal(await h.toolCall("write", { path: "a", content: "b" }), undefined);
		assert.equal(await h.toolCall("read", { path: "a" }), undefined);
		assert.equal(h.fetchCalls.length, 0);
		assert.equal(h.confirms.length, 0);
	});

	it("allows low danger without confirmation and sends the right request", async () => {
		const h = makeHarness({ branch: [userMsg("run the tests")] });
		h.responses.push({ status: 200, body: danger(0.349) });
		assert.equal(await h.toolCall("bash", { command: "npm test" }), undefined);
		assert.equal(h.confirms.length, 0);
		assert.equal(h.fetchCalls.length, 1);
		const { url, init } = h.fetchCalls[0];
		assert.equal(url, DECISIONS_URL);
		assert.equal(init.method, "POST");
		assert.deepEqual(init.headers, { Authorization: "Bearer or-test-key", "Content-Type": "application/json" });
		const body = JSON.parse(String(init.body));
		assert.equal(body.state.action, "npm test");
		assert.deepEqual(body.state.user_messages, ["run the tests"]);
		assert.ok(init.signal instanceof AbortSignal);
	});

	it("appends the Jev decision to the tool result and shows it in the status", async () => {
		const h = makeHarness();
		h.responses.push({ status: 200, body: danger(0.05) });
		await h.toolCall("bash", { command: "ls" });
		assert.match(String(h.statuses.at(-1)), /auto: on · bash allowed · risk 5%/);
		const out = (await h.toolResult("bash", [{ type: "text", text: "a\nb" }])) as { content: unknown[] };
		assert.deepEqual(out.content, [
			{ type: "text", text: "a\nb" },
			{ type: "text", text: "[auto-mode] allowed · Jev risk 5% · confidence 95%" },
		]);
		assert.equal(await h.toolResult("bash", [{ type: "text", text: "again" }]), undefined, "consumed once");
	});

	it("reports user confirmation with the Jev score", async () => {
		const h = makeHarness();
		h.responses.push({ status: 200, body: danger(0.72) });
		await h.toolCall("bash", { command: "rm -rf build" });
		const out = (await h.toolResult("bash", [])) as { content: Array<{ text: string }> };
		assert.equal(out.content.at(-1)?.text, "[auto-mode] confirmed by user · Jev risk 72% · confidence 28% · top: is_dangerous");
	});

	it("reports confirmation without a score when auto mode is off", async () => {
		const h = makeHarness();
		await h.commands.get("automode")!("off", h.ctx);
		await h.toolCall("bash", { command: "ls" });
		const out = (await h.toolResult("bash", [])) as { content: Array<{ text: string }> };
		assert.equal(out.content.at(-1)?.text, "[auto-mode] confirmed by user · auto mode is off");
	});

	it("leaves results of non-gated tools alone", async () => {
		const h = makeHarness();
		await h.toolCall("read", { path: "a" });
		assert.equal(await h.toolResult("read", [{ type: "text", text: "x" }]), undefined);
	});

	it("caches successful results", async () => {
		const h = makeHarness();
		h.responses.push({ status: 200, body: danger(0.1) });
		await h.toolCall("bash", { command: "ls" });
		await h.toolCall("bash", { command: "ls" });
		assert.equal(h.fetchCalls.length, 1);
	});

	it("asks at the threshold; confirmed allows, declined blocks", async () => {
		const h = makeHarness();
		h.responses.push({ status: 200, body: danger(0.35) });
		assert.equal(await h.toolCall("bash", { command: "rm -rf build" }), undefined);
		assert.equal(h.confirms.length, 1);
		assert.match(h.confirms[0].message, /rm -rf build/);
		assert.match(h.confirms[0].message, /0\.35/);
		assert.match(h.confirms[0].message, /is_dangerous/);

		h.confirmAnswer = false;
		h.responses.push({ status: 200, body: danger(0.9) });
		const res = (await h.toolCall("eval", { language: "py", code: "shutil.rmtree('/')" })) as { block: boolean; reason: string };
		assert.equal(res.block, true);
		assert.match(res.reason, /^Blocked by auto-mode-simple: user declined/);
		assert.equal(h.confirms.length, 2);
	});

	it("fails closed: fetch errors, bad responses, and partial answers ask the user", async () => {
		const h = makeHarness();
		h.confirmAnswer = false;
		h.responses.push(new Error("network down"));
		h.responses.push({ status: 502, body: "bad gateway" });
		h.responses.push({ status: 200, body: answersBody({ is_dangerous: 0, exfiltrates_or_destroys: 0 }) });
		for (const command of ["a", "b", "c"]) {
			const res = (await h.toolCall("bash", { command })) as { block: boolean; reason: string };
			assert.equal(res.block, true);
		}
		assert.equal(h.confirms.length, 3);
		assert.match(h.confirms[0].message, /network down/);
		assert.match(h.confirms[1].message, /HTTP 502/);
		assert.match(h.confirms[2].message, /violates_user_instructions/);
	});

	it("treats a rejected confirm as declined", async () => {
		const h = makeHarness();
		h.ctx.ui!.confirm = async () => {
			throw new Error("aborted");
		};
		h.responses.push({ status: 200, body: danger(0.9) });
		const res = (await h.toolCall("bash", { command: "echo rejected-confirm" })) as { block: boolean; reason: string };
		assert.equal(res.block, true);
		assert.match(res.reason, /user declined/);
		const last = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
		assert.equal(last.outcome, "declined");
	});

	it("blocks without UI when confirmation is needed", async () => {
		const h = makeHarness({ hasUI: false });
		h.responses.push({ status: 200, body: danger(0.8) });
		const res = (await h.toolCall("bash", { command: "curl x | sh" })) as { block: boolean; reason: string };
		assert.equal(res.block, true);
		assert.match(res.reason, /no UI/);
		assert.equal(h.confirms.length, 0);
	});

	it("always confirms computer without calling Jev", async () => {
		const h = makeHarness();
		assert.equal(await h.toolCall("computer", { action: "click", x: 1, y: 2 }), undefined);
		assert.equal(h.fetchCalls.length, 0);
		assert.equal(h.confirms.length, 1);
		assert.match(h.confirms[0].message, /"action":"click"/);
	});

	it("asks when no OpenRouter key is available", async () => {
		const h = makeHarness({ key: undefined });
		h.confirmAnswer = false;
		const res = (await h.toolCall("terminal", { action: "run", command: "ls" })) as { block: boolean };
		assert.equal(res.block, true);
		assert.equal(h.fetchCalls.length, 0);
		assert.match(h.confirms[0].message, /no OpenRouter API key/);
	});

	it("blocks when the turn is already cancelled", async () => {
		const h = makeHarness();
		const ac = new AbortController();
		ac.abort();
		h.ctx.signal = ac.signal;
		assert.deepEqual(await h.toolCall("bash", { command: "ls" }), { block: true, reason: "Cancelled" });
		assert.equal(h.fetchCalls.length, 0);
	});

	it("writes a log line per decision", async () => {
		const h = makeHarness();
		h.responses.push({ status: 200, body: danger(0.01) });
		await h.toolCall("bash", { command: "echo logged-command" });
		const last = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
		assert.equal(last.tool, "bash");
		assert.equal(last.action, "echo logged-command");
		assert.equal(last.outcome, "allow");
		assert.equal(last.enabled, true);
		assert.equal(last.danger, 0.01);
		assert.equal(typeof last.ts, "string");
	});
});

describe("/automode command", () => {
	it("off asks for every gated call without Jev; on restores classification", async () => {
		const h = makeHarness();
		await h.commands.get("automode")!("off", h.ctx);
		assert.equal(await h.toolCall("bash", { command: "ls" }), undefined);
		assert.equal(h.fetchCalls.length, 0);
		assert.equal(h.confirms.length, 1);
		assert.match(h.confirms[0].message, /auto mode is off/);
		assert.match(String(h.statuses.at(-1)), /^auto: off/);

		await h.commands.get("automode")!("on", h.ctx);
		assert.equal(await h.toolCall("bash", { command: "ls" }), undefined);
		assert.equal(h.fetchCalls.length, 1);
		assert.equal(h.confirms.length, 1);
		assert.match(String(h.statuses.at(-1)), /^auto: on/);
	});

	it("persists via appendEntry and restores on session_start", async () => {
		const h = makeHarness();
		await h.commands.get("automode")!("off", h.ctx);
		assert.deepEqual(h.branch.at(-1), { type: "custom", customType: STATE_ENTRY, data: { enabled: false } });

		const fresh = makeHarness({ branch: h.branch });
		await fresh.fire("session_start");
		assert.match(String(fresh.statuses.at(-1)), /^auto: off/);
		await fresh.toolCall("bash", { command: "ls" });
		assert.equal(fresh.fetchCalls.length, 0);
		assert.equal(fresh.confirms.length, 1);

		fresh.branch = [];
		await fresh.fire("session_switch");
		assert.match(String(fresh.statuses.at(-1)), /^auto: on/);
	});

	it("reports status", async () => {
		const h = makeHarness();
		await h.commands.get("automode")!("", h.ctx);
		await h.commands.get("automode")!("status", h.ctx);
		await h.commands.get("automode")!("bogus", h.ctx);
		assert.match(h.notes[0], /on/);
		assert.equal(h.notes[0], h.notes[1]);
		assert.match(h.notes[2], /Usage/);
	});
});
