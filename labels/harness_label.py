"""One labelling question through the harness runtime (CGQA_HARNESS, roles.call):
a read-only, repo-scoped tool loop on the LiteLLM gateway, for labellers only reachable there.

Usage: python3 labels/harness_label.py <model> <repo dir> <prompt file> [expect_deployment]
Env: HARNESS_GATEWAY_KEY (the gateway key), optional HARNESS_GATEWAY. PYTHONPATH must hold the
harness checkout. Prints one JSON object: {text, served_by, forced, tool_calls}.
"""
import json
import sys

from harness import roles

model, repo, prompt_file = sys.argv[1:4]
expect = sys.argv[4] if len(sys.argv) > 4 else None
reply = roles.call(
    "scout",
    "You label call sites for a code-graph accuracy study. Use the tools to read the repository; never guess when you can check.",
    open(prompt_file, encoding="utf-8").read(),
    model=model,
    tools=roles.read_only_repo_tools(repo),
    max_turns=30,
    max_tokens=16384,  # Kimi-K3 spends 4k+ reasoning tokens on hard sites; 4096 left 12% unanswered
    timeout=600,
    expect_deployment=expect,
)
print(json.dumps({"text": reply.content, "served_by": reply.served_by_turns, "forced": reply.forced, "tool_calls": reply.tool_calls,
                  "tokens": [reply.prompt_tokens, reply.completion_tokens], "cost": reply.cost}))
