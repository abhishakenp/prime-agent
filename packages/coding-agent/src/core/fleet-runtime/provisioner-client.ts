/**
 * Provisioner client — leases and releases accounts from the account-provisioner pool.
 *
 * The provisioner (~/proj/account-provisioner) runs an HTTP SDK server on
 * localhost:20129. This client provides a typed interface for runtime plugins
 * to lease accounts (GitHub tokens, Cloudflare tokens, etc.) from the pool.
 *
 * Flow:
 * 1. Runtime plugin needs an account → calls leaseAccount(provider)
 * 2. Provisioner returns the least-recently-used active account
 * 3. Plugin uses the account for the spawn
 * 4. When done → calls releaseAccount(provider, email)
 *
 * If no accounts are available, the plugin can request provisioning:
 *   await provisionAccounts(provider, count)
 *
 * This enables multi-account parallelism: 20 GitHub accounts → 400 concurrent
 * Actions jobs. The provisioner handles account creation, rotation, and pool
 * management. Runtime plugins just lease and release.
 */

const DEFAULT_PROVISIONER_URL = "http://localhost:20129";

export interface LeasedAccount {
	provider: string;
	email: string;
	apiKey: string;
	status: string;
	createdAt: string;
	lastUsedAt?: string;
	metadata?: Record<string, unknown>;
}

export interface ProvisionResult {
	success: boolean;
	email?: string;
	apiKey?: string;
	error?: string;
}

function provisionerUrl(): string {
	return process.env.PROVISIONER_URL || DEFAULT_PROVISIONER_URL;
}

/** Check if the provisioner is running and reachable */
export async function isProvisionerAlive(): Promise<boolean> {
	try {
		const resp = await fetch(`${provisionerUrl()}/health`, {
			signal: AbortSignal.timeout(3000),
		});
		return resp.ok;
	} catch {
		return false;
	}
}

/** List all accounts in a provider's pool */
export async function listAccounts(provider: string): Promise<LeasedAccount[]> {
	const resp = await fetch(`${provisionerUrl()}/accounts/${provider}`, {
		signal: AbortSignal.timeout(5000),
	});
	if (!resp.ok) return [];
	const data = (await resp.json()) as { accounts: LeasedAccount[] };
	return data.accounts || [];
}

/** Lease one or more accounts from the pool (round-robin, least-recently-used first) */
export async function leaseAccounts(provider: string, count = 1): Promise<LeasedAccount[]> {
	const resp = await fetch(`${provisionerUrl()}/accounts/${provider}/lease`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ count }),
		signal: AbortSignal.timeout(5000),
	});
	if (!resp.ok) {
		const errBody = (await resp.json().catch(() => ({ error: resp.statusText }))) as { error?: string };
		throw new Error(`Failed to lease ${provider} account: ${errBody.error || resp.status}`);
	}
	const data = (await resp.json()) as { leased: LeasedAccount[] };
	return data.leased || [];
}

/** Lease a single account (convenience wrapper) */
export async function leaseAccount(provider: string): Promise<LeasedAccount> {
	const accounts = await leaseAccounts(provider, 1);
	if (accounts.length === 0) {
		throw new Error(`No ${provider} accounts available in pool`);
	}
	return accounts[0];
}

/** Release a leased account back to the pool */
export async function releaseAccount(provider: string, email: string): Promise<void> {
	await fetch(`${provisionerUrl()}/accounts/${provider}/release`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email }),
		signal: AbortSignal.timeout(5000),
	}).catch(() => {
		// Best-effort — don't fail the spawn if release fails
	});
}

/** Provision new accounts into the pool (triggers browser automation in the provisioner) */
export async function provisionAccounts(provider: string, count = 1, label?: string): Promise<ProvisionResult[]> {
	const resp = await fetch(`${provisionerUrl()}/accounts/${provider}/provision`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ count, label }),
		signal: AbortSignal.timeout(300_000), // 5 min — browser automation is slow
	});
	if (!resp.ok) {
		throw new Error(`Failed to provision ${provider} accounts: ${resp.status}`);
	}
	const data = (await resp.json()) as { results: ProvisionResult[] };
	return data.results || [];
}

/**
 * Lease an account, or auto-provision one if the pool is empty.
 * This is the main entry point for runtime plugins.
 */
export async function ensureAccount(provider: string): Promise<LeasedAccount> {
	// Try leasing first
	try {
		return await leaseAccount(provider);
	} catch {
		// Pool empty — try provisioning one
		const results = await provisionAccounts(provider, 1, `auto-${Date.now() % 100000}`);
		if (results[0]?.success) {
			// Now lease the freshly provisioned account
			return await leaseAccount(provider);
		}
		throw new Error(`Failed to lease or provision ${provider} account: ${results[0]?.error || "unknown"}`);
	}
}
