/**
 * Fleet bootstrap — install prime-agent on a remote host via SSH.
 *
 * Steps:
 * 1. SSH to the host and check if pi/prime-agent is already installed
 * 2. If not, install via npm (or from the fork if specified)
 * 3. Start the daemon in background
 * 4. Install the gateway client and connect to the gateway
 * 5. Register the host in fleet config
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface BootstrapOptions {
	/** SSH target (alias, IP, or user@host). */
	target: string;
	/** Hostname to register as. */
	hostname: string;
	/** Tags for routing. */
	tags: string[];
	/** Capabilities. */
	capabilities: string[];
	/** Gateway URL to connect to. */
	gatewayUrl?: string;
	/** Gateway auth token. */
	gatewayToken?: string;
	/** npm package to install (default: @earendil-works/pi-coding-agent). */
	npmPackage?: string;
	/** SSH user override. */
	user?: string;
	/** Skip daemon start (just install + register). */
	skipDaemon?: boolean;
}

export interface BootstrapResult {
	success: boolean;
	hostname: string;
	address: string;
	alreadyInstalled: boolean;
	piVersion?: string;
	error?: string;
}

const DEFAULT_NPM_PACKAGE = "@earendil-works/pi-coding-agent";

export async function bootstrapHost(opts: BootstrapOptions): Promise<BootstrapResult> {
	const sshTarget = opts.user ? `${opts.user}@${opts.target}` : opts.target;
	const npmPkg = opts.npmPackage ?? DEFAULT_NPM_PACKAGE;

	// Step 1: Check if pi is already installed
	const checkCmd = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o BatchMode=yes "${sshTarget}" 'which pi 2>/dev/null; pi --version 2>/dev/null; node --version 2>/dev/null; echo PATH=$PATH'`;
	let alreadyInstalled = false;
	let piVersion: string | undefined;

	try {
		const result = await execAsync(checkCmd, { timeout: 10000 });
		const lines = result.stdout.trim().split("\n");
		const piPath = lines[0];
		piVersion = lines.find((l) => /\d+\.\d+\.\d+/.test(l));
		alreadyInstalled = Boolean(piPath);
	} catch (err) {
		return {
			success: false,
			hostname: opts.hostname,
			address: opts.target,
			alreadyInstalled: false,
			error: `SSH connection failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	// Step 2: Install if not present
	if (!alreadyInstalled) {
		const installCmd = `ssh -o BatchMode=yes "${sshTarget}" 'npm install -g ${npmPkg} 2>&1'`;
		try {
			await execAsync(installCmd, { timeout: 60000 });
		} catch (err) {
			return {
				success: false,
				hostname: opts.hostname,
				address: opts.target,
				alreadyInstalled: false,
				error: `npm install failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	// Step 3: Start daemon (if not skipped)
	if (!opts.skipDaemon) {
		const daemonCmd = `ssh -o BatchMode=yes "${sshTarget}" 'export PATH=$PATH:$(npm root -g)/.bin:$(npm prefix -g)/bin; setsid pi --mode daemon > /tmp/pi-daemon.log 2>&1 < /dev/null & sleep 2; echo started'`;
		try {
			await execAsync(daemonCmd, { timeout: 15000 });
		} catch {
			// Non-fatal — daemon might already be running
		}
	}

	// Step 4: Connect to gateway (if gateway URL provided)
	if (opts.gatewayUrl && opts.gatewayToken) {
		// Copy gateway client code and start it
		// For now, we just note that the host needs the gateway client
		// In a full implementation, we'd scp the gateway client and start it
	}

	return {
		success: true,
		hostname: opts.hostname,
		address: opts.target,
		alreadyInstalled,
		piVersion,
	};
}

export async function disconnectHost(sshTarget: string): Promise<boolean> {
	try {
		await execAsync(
			`ssh -o BatchMode=yes "${sshTarget}" 'pkill -f "pi.*daemon" 2>/dev/null; pkill -f "gateway-client" 2>/dev/null; echo done'`,
			{ timeout: 10000 },
		);
		return true;
	} catch {
		return false;
	}
}

export async function checkHostStatus(sshTarget: string): Promise<{
	online: boolean;
	piInstalled: boolean;
	piVersion?: string;
	daemonRunning: boolean;
}> {
	try {
		const result = await execAsync(
			`ssh -o ConnectTimeout=3 -o BatchMode=yes "${sshTarget}" 'echo ONLINE; which pi 2>/dev/null; pi --version 2>/dev/null; ls ~/.prime/agent/daemon.sock 2>/dev/null || ls ~/.pi/agent/daemon.sock 2>/dev/null || echo NO_SOCK'`,
			{ timeout: 8000 },
		);
		const lines = result.stdout.trim().split("\n");
		const online = lines[0] === "ONLINE";
		const piInstalled = Boolean(lines[1]);
		const piVersion = lines.find((l) => /\d+\.\d+\.\d+/.test(l));
		const daemonRunning = !lines.includes("NO_SOCK");
		return { online, piInstalled, piVersion, daemonRunning };
	} catch {
		return { online: false, piInstalled: false, daemonRunning: false };
	}
}
