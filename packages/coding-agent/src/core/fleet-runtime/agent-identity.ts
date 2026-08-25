/**
 * Agent identity — each agent is a self-contained unit with a unique identity.
 *
 * Every agent (orchestrator or child) has:
 * - A globally unique agent ID (UUID)
 * - The hostname it runs on
 * - Its session directory
 * - Its depth in the recursion tree
 * - Its parent's identity (if spawned)
 *
 * This identity is used for:
 * - Routing messages through the gateway
 * - File sync requests (agent A requests file from agent B)
 * - Recursive spawning (child knows its parent, can spawn its own children)
 * - Fleet tree view (which agent runs on which host, recursively)
 */

import { randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";

export interface AgentIdentityRecord {
	agentId: string;
	host: string;
	/** Hardware/architecture identifier (e.g. "arm64-darwin", "x64-linux"). */
	hardwareId: string;
	sessionDir: string;
	model: string;
	label: string;
	depth: number;
	parentAgentId?: string;
	parentHost?: string;
	/** When the agent was spawned. */
	startedAt: number;
	/** Tags inherited from the fleet host. */
	tags: string[];
}

/** Create an identity for the root orchestrator (the laptop). */
export function createOrchestratorIdentity(opts?: {
	model?: string;
	sessionDir?: string;
	tags?: string[];
}): AgentIdentityRecord {
	return {
		agentId: randomUUID(),
		host: osHostname(),
		hardwareId: getHardwareId(),
		sessionDir: opts?.sessionDir ?? process.cwd(),
		model: opts?.model ?? "default",
		label: "orchestrator",
		depth: 0,
		startedAt: Date.now(),
		tags: opts?.tags ?? [],
	};
}

/** Create an identity for a spawned child agent. */
export function createChildIdentity(
	parent: AgentIdentityRecord,
	opts: {
		host: string;
		model?: string;
		label: string;
		sessionDir: string;
		tags?: string[];
	},
): AgentIdentityRecord {
	return {
		agentId: randomUUID(),
		host: opts.host,
		hardwareId: getHardwareId(),
		sessionDir: opts.sessionDir,
		model: opts.model ?? parent.model,
		label: opts.label,
		depth: parent.depth + 1,
		parentAgentId: parent.agentId,
		parentHost: parent.host,
		startedAt: Date.now(),
		tags: opts.tags ?? [],
	};
}

/** Get a hardware identifier for the current machine. */
function getHardwareId(): string {
	const arch = process.arch;
	const platform = process.platform;
	return `${arch}-${platform}`;
}

/**
 * Agent tree — tracks the recursive agent hierarchy across hosts.
 *
 * This is what powers the "recursive subagent-to-host attribution" view.
 * Each node knows which host it runs on, its parent, and its children.
 */
export interface AgentTreeNode {
	identity: AgentIdentityRecord;
	children: AgentTreeNode[];
	status: "running" | "completed" | "error" | "aborted";
}

export class AgentTree {
	private nodes = new Map<string, AgentTreeNode>();
	private childrenMap = new Map<string, string[]>();
	private rootId: string | null = null;

	setRoot(identity: AgentIdentityRecord): void {
		this.rootId = identity.agentId;
		this.nodes.set(identity.agentId, {
			identity,
			children: [],
			status: "running",
		});
	}

	addChild(parentId: string, identity: AgentIdentityRecord): void {
		const node: AgentTreeNode = {
			identity,
			children: [],
			status: "running",
		};
		this.nodes.set(identity.agentId, node);

		const siblings = this.childrenMap.get(parentId) ?? [];
		siblings.push(identity.agentId);
		this.childrenMap.set(parentId, siblings);

		const parent = this.nodes.get(parentId);
		if (parent) {
			parent.children.push(node);
		}
	}

	updateStatus(agentId: string, status: AgentTreeNode["status"]): void {
		const node = this.nodes.get(agentId);
		if (node) {
			node.status = status;
		}
	}

	getTree(): AgentTreeNode | null {
		if (!this.rootId) return null;
		return this.nodes.get(this.rootId) ?? null;
	}

	/** Flatten the tree to a list (for display). */
	flatten(): AgentTreeNode[] {
		return Array.from(this.nodes.values());
	}

	/** Find all agents running on a specific host. */
	agentsOnHost(host: string): AgentTreeNode[] {
		return this.flatten().filter((n) => n.identity.host === host);
	}
}
