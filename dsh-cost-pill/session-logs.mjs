#!/usr/bin/env node
/**
 * session-logs.mjs — shared reader for the durable session logs.
 *
 * The logs are multi-frame zstd, so they are decoded through the `zstd` CLI
 * (Node's zstd decoder stops after the first frame).
 */
import { execFile } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export const SESSIONS_ROOT = join(homedir(), '.dsh/sessions');

/** Every session log on this machine, with its workspace and session id. */
export function sessionLogs() {
	const logs = [];
	if (!existsSync(SESSIONS_ROOT)) return logs;
	for (const workspace of readdirSync(SESSIONS_ROOT)) {
		const workspaceDir = join(SESSIONS_ROOT, workspace);
		if (!statSync(workspaceDir).isDirectory()) continue;
		for (const session of readdirSync(workspaceDir)) {
			const sessionDir = join(workspaceDir, session);
			if (!statSync(sessionDir).isDirectory()) continue;
			for (const name of readdirSync(sessionDir)) {
				if (name.startsWith('session.') && (name.endsWith('.jsonl') || name.endsWith('.jsonl.zstd'))) {
					logs.push({ workspace, session, path: join(sessionDir, name), zstd: name.endsWith('.zstd') });
				}
			}
		}
	}
	return logs;
}

/** Yield one decoded JSON object per log line of one session file. */
export async function* readEvents(log) {
	let input;
	if (log.zstd) {
		const child = execFile('zstd', ['-dc', log.path], { maxBuffer: 1024 * 1024 * 512 });
		child.on('error', (error) => console.error(`zstd failed for ${log.path}: ${error.message}`));
		input = child.stdout;
	} else {
		input = createReadStream(log.path);
	}
	const reader = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
	for await (const line of reader) {
		if (line.trim() === '') continue;
		try {
			yield JSON.parse(line);
		} catch {
			// A torn tail line is not evidence.
		}
	}
}

/** Plain session metadata: how the session was created and by which delegation. */
export async function sessionMeta(log) {
	const meta = { origin: 'root', depth: 0, provider: undefined, parent: undefined, label: undefined };
	for await (const event of readEvents(log)) {
		if (event.type === 'session') {
			meta.origin = event.origin ?? 'root';
			meta.depth = event.delegationDepth ?? 0;
			meta.parent = event.parentSession;
		}
		if (event.type === 'subagent/descriptor') {
			meta.provider = event.data?.provider;
			meta.label = event.data?.label;
		}
		if (meta.origin !== 'root' && meta.provider !== undefined) break;
	}
	return meta;
}
