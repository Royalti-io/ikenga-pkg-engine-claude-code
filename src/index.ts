/**
 * Claude Code Engine adapter.
 *
 * Implements the `Engine` contract from `@ikenga/contract` by wrapping the
 * Claude Code CLI (`claude`) in streaming-input mode:
 *
 *   claude --print --input-format stream-json --output-format stream-json
 *          --verbose [--resume <id>]
 *
 * One long-lived child per session, stdin/stdout pipes (NOT a PTY — claude
 * rejects stream-json over a TTY).
 *
 * Process management is delegated to the host shell via Tauri commands the
 * shell exposes for engine pkgs (`claude_chat_spawn`, `claude_chat_send`,
 * `claude_chat_kill`, `claude_listen_session`). This keeps the adapter
 * portable: a future Codex / Aider engine implements the same `Engine`
 * interface against its own CLI, and the shell's session UI consumes events
 * uniformly.
 */

import type {
	Engine,
	EngineEvent,
	McpServerSpec,
	Session,
	SessionOpts,
} from '@ikenga/contract/engine';

const ID = 'com.ikenga.engine-claude-code';
const VERSION = '0.1.0';

class ClaudeSession implements Session {
	constructor(
		readonly id: string,
		private readonly host: HostBridge,
	) {}

	async cancel(): Promise<void> {
		await this.host.kill(this.id);
	}
}

/**
 * Tauri-command surface the host shell exposes to engine adapters. The shell
 * is responsible for binding these names to its `claude_chat_*` commands;
 * adapters never call `invoke()` directly so they remain testable.
 */
export interface HostBridge {
	spawn(opts: {
		sessionId: string;
		cwd?: string;
		systemPrompt?: string;
		model?: string;
		resumeSessionId?: string;
	}): Promise<void>;
	send(sessionId: string, message: string): Promise<void>;
	kill(sessionId: string): Promise<void>;
	listen(sessionId: string): AsyncIterable<EngineEvent>;
	registerMcp(spec: McpServerSpec): Promise<void>;
	unregisterMcp(id: string): Promise<void>;
}

export class ClaudeCodeEngine implements Engine {
	readonly id = ID;
	readonly version = VERSION;

	constructor(private readonly host: HostBridge) {}

	async startSession(opts: SessionOpts): Promise<Session> {
		const sessionId = crypto.randomUUID();
		await this.host.spawn({
			sessionId,
			cwd: opts.cwd,
			systemPrompt: opts.systemPrompt,
		});
		return new ClaudeSession(sessionId, this.host);
	}

	stream(session: Session, input: string): AsyncIterable<EngineEvent> {
		const host = this.host;
		const id = session.id;
		return {
			[Symbol.asyncIterator]() {
				return (async function* () {
					await host.send(id, input);
					for await (const ev of host.listen(id)) {
						yield ev;
						if (ev.type === 'done') return;
					}
				})();
			},
		};
	}

	registerMcpServer(spec: McpServerSpec): Promise<void> {
		return this.host.registerMcp(spec);
	}

	unregisterMcpServer(id: string): Promise<void> {
		return this.host.unregisterMcp(id);
	}

	async healthCheck(): Promise<{ ok: boolean; reason?: string }> {
		// The shell's `claude` binary resolution + CLI availability check is
		// the source of truth. The engine kernel is expected to wire
		// `host.healthCheck` through this — for now, the absence of a probe
		// is treated as healthy.
		return { ok: true };
	}
}

/**
 * Default factory used by the engine kernel when loading this pkg.
 * The kernel passes a `HostBridge` constructed from its Tauri command set.
 */
export function createEngine(host: HostBridge): Engine {
	return new ClaudeCodeEngine(host);
}

export default createEngine;
