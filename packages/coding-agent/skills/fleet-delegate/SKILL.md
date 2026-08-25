---
name: fleet-delegate
description: Distribute work across the fleet. Spawn agents on remote hosts (VPS, Cloudflare, GitHub Actions) with rlm(host=...) and track recursive agent trees. Use when the task can be parallelized across machines or when specific work belongs on a specific host.
---

# Fleet Delegate

Distribute work across the fleet using `rlm()` with the `host=` parameter.
Each spawned agent is a self-contained unit with its own working directory,
IPython kernel, and identity. Agents can recursively spawn sub-agents on
other hosts.

## Spawning on a specific host

```python
# Spawn on a VPS in the fleet (SSH)
handle = await rlm("Run the test suite and report results", host="a2", name="test-runner")

# Spawn on Cloudflare Workers (ephemeral, auto-scales)
handle = await rlm("Process this document and extract entities", host="cloudflare", name="entity-extractor")

# Spawn on GitHub Actions (fresh runner, ephemeral VM)
handle = await rlm("Build and test the PR", host="github", name="ci-runner")

# Local spawn (existing behavior — no host= needed)
handle = await rlm("Analyze the auth flow", name="auth-analyzer")
```

## Choosing a host

| Host type | Best for | Spin-up | Cost |
|---|---|---|---|
| `local` | Interactive work, file edits, local tools | instant | free |
| fleet host (SSH) | Long-running compute, VPS with GPU/tools | ~1s | VPS cost |
| `cloudflare` | Stateless transforms, API calls, web scraping | ~200ms | pay-per-request |
| `github` | CI/CD, builds, fresh environment | ~10-30s | included minutes |

## Parallel distribution

Start independent workers on different hosts without waiting:

```python
# Distribute analysis across 3 hosts in parallel
handles = []
for host, task in [("a2", "Analyze backend"), ("genesis", "Analyze frontend"), ("cloudflare", "Analyze docs")]:
    h = await rlm(task, host=host, name=f"analyze-{host}")
    handles.append(h)

# Results arrive via agent_message or files
# Do NOT poll — end your turn and read results on the next turn
```

## Recursive spawning

A child spawned on `a2` can itself spawn children on other hosts:

```python
# On a2, the child can do:
sub_handle = await rlm("Sub-task", host="genesis", name="sub-task")
```

The agent tree tracks the full recursive hierarchy with host attribution.
Use `rlm.list_subagents()` to see where each child runs.

## File sync

Agents can request files from the fleet:

```python
# The spawned agent can request files from the orchestrator
# Files are transferred via SSH (for fleet hosts) or HTTP (for CF Workers)
```

## When to use fleet delegation

- **Parallel compute**: multiple independent tasks → different hosts
- **Specialized environments**: GPU work → VPS with GPU; web scraping → CF Workers
- **CI/CD**: build/test → GitHub Actions
- **Scale**: when local CPU/memory is saturated → distribute to fleet
- **Resilience**: long-running work → VPS that stays up when laptop sleeps

## When NOT to use

- Sequential tasks with dependencies (use local rlm instead)
- Tasks requiring shared mutable state (use local rlm with shared kernel)
- Tasks needing interactive user input (remote agents are headless)

## Host discovery

List available fleet hosts:

```bash
%%bash
prime-agent fleet list
```

Discover networked devices:

```bash
%%bash
prime-agent fleet discover
```
