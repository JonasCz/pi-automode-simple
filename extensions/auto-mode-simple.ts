/**
 * pi-automode-simple: gate shell, code-exec, terminal, and desktop-control tool
 * calls with the Jev decision model on OpenRouter. Low-danger calls run; risky
 * calls, classifier errors, and everything while auto mode is off need the
 * user's confirmation. This is not a sandbox and not a security boundary.
 *
 * Loads in Pi and oh-my-pi (omp): the host API is described by the minimal
 * local interfaces below instead of host package imports.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Minimal host API
// ---------------------------------------------------------------------------

export interface SessionEntry {
	type: string;
	customType?: string;
	data?: unknown;
	message?: unknown;
}

export interface HostContext {
	cwd: string;
	hasUI?: boolean;
	signal?: AbortSignal;
	ui?: {
		confirm?(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
		notify?(message: string, type?: string): void;
	};
	sessionManager?: {
		getBranch?(): SessionEntry[];
		getEntries?(): SessionEntry[];
	};
	modelRegistry?: {
		getApiKeyForProvider?(provider: string): unknown;
	};
}

export interface HostApi {
	on(event: string, handler: (event: any, ctx: HostContext) => unknown): void;
	registerCommand(
		name: string,
		options: { description: string; handler: (args: string, ctx: HostContext) => Promise<void> | void },
	): void;
	appendEntry(customType: string, data: unknown): void;
}

export interface ToolCallEvent {
	toolName: string;
	toolCallId?: string;
	input?: unknown;
}

export type ToolCallResult = { block: true; reason: string } | undefined;

export interface ToolResultEvent {
	toolName: string;
	toolCallId?: string;
	content?: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const STATE_ENTRY = "pi-automode-simple:state";
export const DANGER_THRESHOLD = 0.35;
export const JEV_MODEL = "~typesafe/jev-latest";
export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const TIMEOUT_MS = 12_000;
const CACHE_LIMIT = 200;
const CLASSIFIED_TOOLS = new Set(["bash", "eval", "terminal"]);
const GATED_TOOLS = new Set([...CLASSIFIED_TOOLS, "computer"]);
const RULES_FILE = ".agent/auto-mode-classifier-rules.md";

export const JEV_QUESTIONS: Record<string, { type: "noul"; instructions: string }> = {
	is_dangerous: {
		type: "noul",
		instructions:
			"Executing the tool call described in `action` would be dangerous: it risks irreversible data loss, " +
			"credential exfiltration, harm to other systems, supply-chain compromise, or escaping the project in " +
			"`working_directory`. Judge this in light of what the user asked for in `user_messages` and " +
			"`user_answers`; ordinary development the user requested (running tests, builds, editing project " +
			"files, routine git) is not dangerous.",
	},
	exfiltrates_or_destroys: {
		type: "noul",
		instructions:
			"The tool call described in `action` sends credentials or sensitive data to an outside party, " +
			"destroys data irreversibly, or runs remotely-fetched code.",
	},
	violates_user_instructions: {
		type: "noul",
		instructions:
			"The tool call described in `action` contradicts an explicit instruction in `user_messages`, " +
			"`user_answers`, or `project_rules`, including any instruction to deny, block, refuse, or not run " +
			"this kind of action.",
	},
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
	/\bsk-(ant|or-v1|live|test)-[A-Za-z0-9_-]{8,}/g,
	/\bsk-ant-oat[A-Za-z0-9_-]{8,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bxox[baprs]-[A-Za-z0-9-]{8,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\bAIza[0-9A-Za-z_-]{20,}/g,
	/(?<=['"]?(api[_-]?key|token|secret|password|passwd|auth)['"]?\s*[:=]\s*['"]?)[^'"\s;,}]{8,}/gi,
	/(?<=--(token|api-key|api_key|password)\s*=\s*)\S{8,}/gi,
	/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/g,
];

export function redactSecrets(text: string): string {
	let out = text;
	for (const re of SECRET_PATTERNS) {
		re.lastIndex = 0;
		out = out.replace(re, "[REDACTED]");
	}
	return out;
}

export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, max) + `…[truncated ${text.length - max} chars]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Human-readable description of the requested action for one gated tool. */
export function summarizeAction(toolName: string, input: unknown): string {
	const rec = isRecord(input) ? input : {};
	if (toolName === "bash" && typeof rec.command === "string") return rec.command;
	if (toolName === "eval" && typeof rec.code === "string") {
		return `[${typeof rec.language === "string" ? rec.language : "unknown language"}]\n${rec.code}`;
	}
	const fields: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(rec)) if (v !== null && v !== undefined) fields[k] = v;
	return JSON.stringify(fields);
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => isRecord(b) && b.type === "text" && typeof b.text === "string")
		.map((b) => (b as { text: string }).text)
		.join("\n");
}

function formatAnswer(answer: unknown): string {
	return Array.isArray(answer) ? answer.map(String).join(", ") : String(answer);
}

/** Trusted conversation context: the user's own messages and their answers to the `ask` tool. */
export function extractUserContext(entries: SessionEntry[]): { userMessages: string[]; userAnswers: string[] } {
	const userMessages: string[] = [];
	const userAnswers: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !isRecord(entry.message)) continue;
		const msg = entry.message;
		if (msg.role === "user") {
			if (msg.attribution !== undefined && msg.attribution !== "user") continue;
			const text = textContent(msg.content).trim();
			if (text) userMessages.push(text);
		} else if (msg.role === "toolResult" && msg.toolName === "ask" && msg.isError !== true) {
			const details = isRecord(msg.details) ? msg.details : {};
			if (details.timedOut === true) continue;
			let text = "";
			if (Array.isArray(details.answers) && details.answers.length > 0) {
				text = details.answers
					.filter(isRecord)
					.map((a) => `Q: ${String(a.question ?? "")}\nA: ${formatAnswer(a.answer)}`)
					.join("\n");
			} else {
				text = textContent(msg.content).trim();
			}
			if (text && !text.startsWith("No answer before the timeout")) userAnswers.push(text);
		}
	}
	return { userMessages: userMessages.slice(-6), userAnswers: userAnswers.slice(-6) };
}

export function readProjectRules(cwd: string): string {
	try {
		return redactSecrets(truncate(readFileSync(join(cwd, RULES_FILE), "utf8"), 6000));
	} catch {
		return "";
	}
}

export interface JevState {
	tool: string;
	action: string;
	working_directory: string;
	user_messages: string[];
	user_answers: string[];
	project_rules: string;
}

export function buildJevState(opts: { tool: string; action: string; cwd: string; entries: SessionEntry[] }): JevState {
	const { userMessages, userAnswers } = extractUserContext(opts.entries);
	const clean = (t: string) => redactSecrets(truncate(t, 1500));
	return {
		tool: opts.tool,
		action: redactSecrets(truncate(opts.action, 4000)),
		working_directory: opts.cwd,
		user_messages: userMessages.map(clean),
		user_answers: userAnswers.map(clean),
		project_rules: readProjectRules(opts.cwd),
	};
}

export function buildJevBody(state: JevState): string {
	return JSON.stringify({ model: JEV_MODEL, state, questions: JEV_QUESTIONS });
}

export type JevResult = { ok: true; danger: number; top: string } | { ok: false; error: string };

/** Every question must come back with a numeric `noul`; anything else is an error (fail closed). */
export function parseJevResponse(status: number, body: string): JevResult {
	if (status < 200 || status >= 300) return { ok: false, error: `HTTP ${status}: ${truncate(body, 200)}` };
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { ok: false, error: `HTTP ${status}: unreadable response` };
	}
	const answers = isRecord(parsed) ? parsed.answers : undefined;
	if (!isRecord(answers)) return { ok: false, error: "response has no answers map" };
	let danger = -1;
	let top = "";
	for (const id of Object.keys(JEV_QUESTIONS)) {
		const answer = answers[id];
		const p = isRecord(answer) ? answer.noul : undefined;
		if (typeof p !== "number" || Number.isNaN(p)) return { ok: false, error: `missing or malformed answer for ${id}` };
		const clamped = Math.min(1, Math.max(0, p));
		if (clamped > danger) {
			danger = clamped;
			top = id;
		}
	}
	return { ok: true, danger, top };
}

export function restoreEnabled(entries: SessionEntry[]): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "custom" && e.customType === STATE_ENTRY && isRecord(e.data) && typeof e.data.enabled === "boolean") {
			return e.data.enabled;
		}
	}
	return true;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** One-line decision note appended to the tool result, e.g. "[auto-mode] allowed · Jev risk 5% · confidence 95%". */
export function formatDecision(outcome: "allowed" | "confirmed by user", why: string, danger?: number, top?: string): string {
	const parts = [`[auto-mode] ${outcome}`];
	if (danger === undefined) parts.push(why);
	else {
		parts.push(`Jev risk ${pct(danger)}`, `confidence ${pct(1 - danger)}`);
		if (outcome !== "allowed" && top) parts.push(`top: ${top}`);
	}
	return parts.join(" · ");
}

export function defaultLogPath(): string {
	if (process.env.AUTOMODE_SIMPLE_LOG) return process.env.AUTOMODE_SIMPLE_LOG;
	const omp = join(homedir(), ".omp", "agent");
	if (existsSync(omp)) return join(omp, "auto-mode-simple.log");
	return join(homedir(), ".pi", "agent", "auto-mode-simple.log");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

function sessionEntries(ctx: HostContext): SessionEntry[] {
	try {
		const sm = ctx.sessionManager;
		return sm?.getBranch?.() ?? sm?.getEntries?.() ?? [];
	} catch {
		return [];
	}
}

async function openRouterKey(ctx: HostContext): Promise<string | undefined> {
	try {
		const registry = ctx.modelRegistry;
		if (registry && typeof registry.getApiKeyForProvider === "function") {
			const key = await registry.getApiKeyForProvider("openrouter");
			if (typeof key === "string" && key) return key;
		}
	} catch {
		// fall through to the environment
	}
	return process.env.OPENROUTER_API_KEY || undefined;
}

export function createAutoModeSimple(deps: { fetch?: typeof fetch; now?: () => Date } = {}) {
	const doFetch = deps.fetch ?? fetch;
	const now = deps.now ?? (() => new Date());

	return function autoModeSimple(pi: HostApi): void {
		let enabled = true;
		const cache = new Map<string, { danger: number; top: string }>();
		// toolCallId -> decision note, consumed by the matching tool_result.
		const notes = new Map<string, string>();

		const log = (fields: Record<string, unknown>) => {
			try {
				appendFileSync(defaultLogPath(), JSON.stringify({ ts: now().toISOString(), ...fields }) + "\n");
			} catch {
				// logging must never break a tool call
			}
		};

		const record = (event: ToolCallEvent, note: string) => {
			if (!event.toolCallId) return;
			if (notes.size >= CACHE_LIMIT) notes.delete(notes.keys().next().value as string);
			notes.set(event.toolCallId, note);
		};

		pi.on("tool_result", (event: ToolResultEvent) => {
			const note = event.toolCallId ? notes.get(event.toolCallId) : undefined;
			if (!note || !GATED_TOOLS.has(event.toolName)) return undefined;
			notes.delete(event.toolCallId!);
			const content = Array.isArray(event.content) ? event.content : [];
			return { content: [...content, { type: "text", text: note }] };
		});

		const restore = (_event: unknown, ctx: HostContext) => {
			enabled = restoreEnabled(sessionEntries(ctx));
		};
		for (const name of ["session_start", "session_switch", "session_branch", "session_tree"]) pi.on(name, restore);

		pi.registerCommand("automode", {
			description: "Auto-mode-simple: /automode on | off | status",
			handler: async (args, ctx) => {
				const arg = args.trim().toLowerCase();
				let msg: string;
				if (arg === "on" || arg === "off") {
					enabled = arg === "on";
					pi.appendEntry(STATE_ENTRY, { enabled });
					msg = `Auto mode ${arg}.`;
				} else if (arg === "" || arg === "status") {
					msg = enabled
						? "Auto mode is on: bash/eval/terminal are classified by Jev; risky calls need confirmation."
						: "Auto mode is off: every bash/eval/terminal/computer call needs confirmation.";
				} else {
					msg = "Usage: /automode on | off | status";
				}
				ctx.ui?.notify?.(msg, "info");
			},
		});

		const classify = async (ctx: HostContext, tool: string, action: string): Promise<JevResult> => {
			const key = await openRouterKey(ctx);
			if (!key) return { ok: false, error: "no OpenRouter API key (log in to OpenRouter or set OPENROUTER_API_KEY)" };
			const body = buildJevBody(buildJevState({ tool, action, cwd: ctx.cwd, entries: sessionEntries(ctx) }));
			const hit = cache.get(body);
			if (hit) {
				cache.delete(body);
				cache.set(body, hit);
				return { ok: true, ...hit };
			}
			const signals = [AbortSignal.timeout(TIMEOUT_MS), ...(ctx.signal ? [ctx.signal] : [])];
			try {
				const res = await doFetch(DECISIONS_URL, {
					method: "POST",
					headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
					body,
					signal: AbortSignal.any(signals),
				});
				const result = parseJevResponse(res.status, await res.text());
				if (result.ok) {
					if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
					cache.set(body, { danger: result.danger, top: result.top });
				}
				return result;
			} catch (err) {
				return { ok: false, error: `request failed: ${err instanceof Error ? err.message : String(err)}` };
			}
		};

		pi.on("tool_call", async (event: ToolCallEvent, ctx: HostContext): Promise<ToolCallResult> => {
			const tool = event.toolName;
			if (!GATED_TOOLS.has(tool)) return undefined;
			const action = summarizeAction(tool, event.input);
			const entry: Record<string, unknown> = { tool, action: redactSecrets(truncate(action, 300)), enabled };
			if (ctx.signal?.aborted) {
				log({ ...entry, outcome: "blocked-cancelled" });
				return { block: true, reason: "Cancelled" };
			}

			let why: string;
			try {
				if (!enabled) {
					why = "auto mode is off";
				} else if (!CLASSIFIED_TOOLS.has(tool)) {
					why = "desktop control always needs confirmation";
				} else {
					const result = await classify(ctx, tool, action);
					if (result.ok) {
						entry.danger = result.danger;
						entry.top = result.top;
						if (result.danger < DANGER_THRESHOLD) {
							log({ ...entry, outcome: "allow" });
						record(event, formatDecision("allowed", "", result.danger));
							return undefined;
						}
						why = `Jev danger ${result.danger.toFixed(2)} (top: ${result.top})`;
					} else {
						entry.error = result.error;
						why = `classifier error: ${result.error}`;
					}
				}
			} catch (err) {
				entry.error = err instanceof Error ? err.message : String(err);
				why = `classifier error: ${entry.error}`;
			}

			const confirm = ctx.ui?.confirm;
			if (!ctx.hasUI || typeof confirm !== "function") {
				log({ ...entry, outcome: "blocked-no-ui" });
				return { block: true, reason: `Blocked by auto-mode-simple: no UI to confirm (${why})` };
			}
			if (ctx.signal?.aborted) {
				log({ ...entry, outcome: "blocked-cancelled" });
				return { block: true, reason: "Cancelled" };
			}
			let confirmed = false;
			try {
				confirmed = await confirm.call(
					ctx.ui,
					`Auto mode: allow ${tool}?`,
					`Tool: ${tool}\nReason: ${why}\n\nAction:\n${truncate(action, 800)}\n\nAllow this call?`,
					{ signal: ctx.signal },
				);
			} catch {
				confirmed = false;
			}
			log({ ...entry, outcome: confirmed ? "confirmed" : "declined" });
			const danger = typeof entry.danger === "number" ? entry.danger : undefined;
			if (confirmed) {
				record(event, formatDecision("confirmed by user", why, danger, entry.top as string | undefined));
				return undefined;
			}
			return { block: true, reason: `Blocked by auto-mode-simple: user declined (${why})` };
		});
	};
}

export default createAutoModeSimple();
