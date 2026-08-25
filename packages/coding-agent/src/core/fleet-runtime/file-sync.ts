/**
 * Fleet file sync — agents request files from the fleet and send results back.
 *
 * Each agent runs in its own working directory (~/<session-dir> on the target).
 * When it needs a file from the orchestrator or another fleet member, it
 * requests it through this layer.
 *
 * Flow:
 * 1. Agent on a2 needs a file from the orchestrator (laptop)
 * 2. Agent calls: request_file("src/config.ts", from="orchestrator")
 * 3. Request routes through the gateway to the orchestrator
 * 4. Orchestrator sends the file content back
 * 5. Agent writes it to its local working directory
 *
 * Results flow back the same way:
 * 1. Agent on a2 produces output in ~/session-dir/output.json
 * 2. Orchestrator calls: request_file("output.json", from="a2-agent-id")
 * 3. File content returns through the gateway
 *
 * All paths are relative to the agent's session directory.
 * No absolute paths. No escaping the working directory.
 */

import { join, normalize, resolve, sep } from "node:path";

export interface FileSyncRequest {
	/** Path relative to the source agent's session directory. */
	path: string;
	/** Source agent ID (or "orchestrator" for the root). */
	from: string;
	/** Requesting agent ID. */
	to: string;
	/** Unique request ID for correlation. */
	requestId: string;
}

export interface FileSyncResponse {
	requestId: string;
	/** File content (text). Binary files should be base64-encoded. */
	content: string;
	/** Whether the file was found. */
	found: boolean;
	/** Error message if retrieval failed. */
	error?: string;
}

/**
 * Validate that a path is safe (relative, no escaping the session dir).
 * Returns the normalized path or throws.
 */
export function validateSyncPath(path: string): string {
	const normalized = normalize(path);
	if (normalized.startsWith("..") || normalized.startsWith(`..${sep}`) || normalized.startsWith(sep)) {
		throw new Error(`Unsafe path: "${path}" — must be relative to session directory`);
	}
	return normalized;
}

/**
 * Resolve a file sync path relative to a session directory.
 * Ensures the path stays within the session dir.
 */
export function resolveSessionPath(sessionDir: string, relativePath: string): string {
	const safe = validateSyncPath(relativePath);
	return resolve(join(sessionDir, safe));
}

/**
 * File sync handler — lives on each agent.
 *
 * - `handleRequest`: when another agent requests a file from us
 * - `requestFile`: when we need a file from another agent
 */
export interface FileSyncHandler {
	/** Read a file from our session dir and return content. */
	handleRequest: (path: string) => Promise<FileSyncResponse>;
	/** Request a file from another agent (via gateway or direct). */
	requestFile: (path: string, fromAgentId: string) => Promise<FileSyncResponse>;
	/** Send a file to another agent's session dir. */
	sendFile: (path: string, content: string, toAgentId: string) => Promise<void>;
}

/**
 * Local file sync — for agents running on the same host.
 * Reads/writes directly from the filesystem.
 */
export class LocalFileSync implements FileSyncHandler {
	constructor(
		readonly _sessionDir: string,
		private readonly readFile: (path: string) => Promise<string>,
		private readonly writeFile: (path: string, content: string) => Promise<void>,
	) {}

	async handleRequest(path: string): Promise<FileSyncResponse> {
		try {
			const safePath = validateSyncPath(path);
			const content = await this.readFile(safePath);
			return { requestId: "", content, found: true };
		} catch (err) {
			return {
				requestId: "",
				content: "",
				found: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async requestFile(path: string, _fromAgentId: string): Promise<FileSyncResponse> {
		// Local sync — just read from our own filesystem
		return this.handleRequest(path);
	}

	async sendFile(path: string, content: string, _toAgentId: string): Promise<void> {
		const safePath = validateSyncPath(path);
		await this.writeFile(safePath, content);
	}
}
