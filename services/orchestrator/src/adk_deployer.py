"""
ADK Deployer — Architecture Spec v1.0 Compliant
Deploys real ADK agents to Vertex AI Agent Engine (Reasoning Engine).

Called by the orchestrator's POST /api/agents endpoint.
Receives agent config as JSON argument and deploys to Vertex AI.

All agent logic from egap_agent/core.py is inlined here so that
cloudpickle only references standard pip-installable packages
(google-adk, google-genai, requests). No custom package installation
is needed in the Vertex AI build container.
"""

import sys
import os
import json
import logging
from typing import Optional

import vertexai
from google.cloud import storage

logger = logging.getLogger("adk-deployer")
logging.basicConfig(level=logging.INFO)


# ═════════════════════════════════════════════════════════════════════════════
# INLINED FROM egap_agent/core.py — Agent logic, tools, HITL callbacks
# ═════════════════════════════════════════════════════════════════════════════

import requests as req_lib
from google.adk.agents import Agent
from google.adk.tools import FunctionTool
from google.genai import types

# Configuration
_PROJECT_ID = os.getenv("PROJECT_ID", "gls-training-486405")
_LOCATION = os.getenv("LOCATION", "us-central1")
_MODEL_NAME = os.getenv("MODEL_NAME", "gemini-2.5-flash")
_FACTORY_URL = os.getenv("FACTORY_URL", "http://localhost:3000")
_MCP_HUB_URL = os.getenv("MCP_HUB_URL", "http://localhost:8080")

_agent_logger = logging.getLogger("egap-adk-agent")


# ─── HITL Callbacks ───────────────────────────────────────────────────────────

def _hitl_before_tool_callback(tool, args, tool_context):
    """HITL Suspend & Resume: intercepts WRITE tools before execution."""
    tool_name = tool.name if hasattr(tool, 'name') else str(tool)
    write_tools = {"send_email", "save_file"}

    if tool_name in write_tools:
        _agent_logger.info(f"🔒 HITL INTERCEPT: Tool '{tool_name}' is a WRITE tool. Suspending.")
        agent_id = getattr(tool_context, 'agent_id', None) or os.getenv("AGENT_ID", "unknown")
        trace_id = getattr(tool_context, 'trace_id', None) or "no-trace"

        try:
            task_payload = {
                "description": f"Agent requested WRITE operation: {tool_name}",
                "agentId": agent_id,
                "inputPayload": args,
                "traceId": trace_id,
            }
            resp = req_lib.post(f"{_FACTORY_URL}/api/tasks/hitl", json=task_payload, timeout=10)
            task_id = resp.json().get("id", "unknown") if resp.ok else "error"
            if resp.ok:
                _agent_logger.info(f"⏳ HITL Task {task_id} created. Execution suspended.")
            else:
                _agent_logger.error(f"❌ Failed to create HITL task: {resp.text}")
        except Exception as e:
            task_id = "error"
            _agent_logger.error(f"❌ Failed to create HITL task: {e}")

        return {
            "status": "PENDING_APPROVAL",
            "message": (
                f"Tool '{tool_name}' requires Human-in-the-Loop approval. "
                f"A task (ID: {task_id}) has been created for admin review. "
                f"Execution is suspended until approval."
            ),
        }

    _agent_logger.info(f"✅ Tool '{tool_name}' is a READ tool. Allowing execution.")
    return None


def _hitl_after_tool_callback(tool, args, tool_context, tool_response):
    """AgentOps Cost Accounting: logs tool execution for cost tracking."""
    tool_name = tool.name if hasattr(tool, 'name') else str(tool)
    _agent_logger.info(f"📊 Tool executed: {tool_name}")

    try:
        agent_id = getattr(tool_context, 'agent_id', None) or os.getenv("AGENT_ID", "unknown")
        req_lib.post(
            f"{_FACTORY_URL}/api/usage-log",
            json={
                "agentId": agent_id,
                "action": f"tool_execute_{tool_name}",
                "tokens": 0,
                "costUsd": 0,
                "metadata": {"tool": tool_name, "args_keys": list(args.keys())},
            },
            timeout=5,
        )
    except Exception as e:
        _agent_logger.warning(f"Failed to log tool usage: {e}")

    return None


# ─── MCP Tool Wrappers ───────────────────────────────────────────────────────

def search_vertex_docs(query: str) -> str:
    """Search the official Vertex AI documentation for technical answers.
    This is a READ tool — executes immediately.

    Args:
        query: The search query string.

    Returns:
        Relevant documentation snippets.
    """
    try:
        resp = req_lib.post(
            f"{_MCP_HUB_URL}/mcp",
            json={
                "jsonrpc": "2.0",
                "method": "tools/call",
                "params": {"name": "search_vertex_docs", "arguments": {"query": query}},
                "id": 1,
            },
            timeout=30,
        )
        if resp.ok:
            result = resp.json()
            if "result" in result:
                content = result["result"].get("content", [])
                return content[0].get("text", "No results") if content else "No results"
        return "Error calling MCP search tool"
    except Exception as e:
        return f"MCP tool error: {e}"


def send_email(to_email: str, subject: str, body: str) -> str:
    """Send an email to a recipient. Requires subject and body.
    ⚠️ WRITE tool — requires HITL approval before execution.

    Args:
        to_email: Recipient email address.
        subject: Email subject line.
        body: Email body content.

    Returns:
        Confirmation or status message.
    """
    try:
        resp = req_lib.post(
            f"{_MCP_HUB_URL}/mcp",
            json={
                "jsonrpc": "2.0",
                "method": "tools/call",
                "params": {
                    "name": "send_email",
                    "arguments": {"to_email": to_email, "subject": subject, "body": body},
                },
                "id": 1,
            },
            timeout=30,
        )
        if resp.ok:
            result = resp.json()
            content = result.get("result", {}).get("content", [])
            return content[0].get("text", "Email sent") if content else "Email sent"
        return "Error calling MCP email tool"
    except Exception as e:
        return f"MCP tool error: {e}"


def save_file(filename: str, content: str) -> str:
    """Save text content to a file in Google Cloud Storage.
    ⚠️ WRITE tool — requires HITL approval before execution.

    Args:
        filename: Name of the file to create.
        content: Text content to save.

    Returns:
        GCS URI of the saved file.
    """
    try:
        resp = req_lib.post(
            f"{_MCP_HUB_URL}/mcp",
            json={
                "jsonrpc": "2.0",
                "method": "tools/call",
                "params": {
                    "name": "save_file",
                    "arguments": {"filename": filename, "content": content},
                },
                "id": 1,
            },
            timeout=30,
        )
        if resp.ok:
            result = resp.json()
            content_items = result.get("result", {}).get("content", [])
            return content_items[0].get("text", "File saved") if content_items else "File saved"
        return "Error calling MCP save_file tool"
    except Exception as e:
        return f"MCP tool error: {e}"


# ─── Agent Factory ────────────────────────────────────────────────────────────

_TOOL_REGISTRY = {
    "search_vertex_docs": search_vertex_docs,
    "send_email": send_email,
    "save_file": save_file,
}


def _create_egap_agent(
    agent_id: str,
    name: str,
    system_prompt: str,
    tool_names: list,
    model_name: str = None,
) -> Agent:
    """Create an ADK Agent from EGAP configuration (inlined)."""
    if model_name is None:
        model_name = _MODEL_NAME

    agent_tools = []
    for tool_name in tool_names:
        if tool_name in _TOOL_REGISTRY:
            agent_tools.append(_TOOL_REGISTRY[tool_name])
            _agent_logger.info(f"  📎 Attached tool: {tool_name}")
        else:
            _agent_logger.warning(f"  ⚠️ Unknown tool: {tool_name} — skipping")

    os.environ["AGENT_ID"] = agent_id

    # ADK Agent names must be valid Python identifiers
    import re
    safe_name = re.sub(r'[^a-zA-Z0-9_]', '_', name.lower())
    if not safe_name[0].isalpha():
        safe_name = 'agent_' + safe_name

    agent = Agent(
        name=safe_name,
        model=model_name,
        instruction=system_prompt,
        tools=agent_tools,
        before_tool_callback=_hitl_before_tool_callback,
        after_tool_callback=_hitl_after_tool_callback,
    )

    _agent_logger.info(f"✅ Created ADK Agent: {name} (id={agent_id}, tools={tool_names})")
    return agent


# ═════════════════════════════════════════════════════════════════════════════
# Deployer main — Deploys to Vertex AI Agent Engine
# ═════════════════════════════════════════════════════════════════════════════

from vertexai.preview.reasoning_engines.templates.adk import AdkApp
from google.adk.sessions.in_memory_session_service import InMemorySessionService
from google.adk.artifacts.in_memory_artifact_service import InMemoryArtifactService
from google.adk.memory.in_memory_memory_service import InMemoryMemoryService


def main():
    if len(sys.argv) < 2:
        print("Error: Missing JSON payload.", file=sys.stderr)
        sys.exit(1)

    try:
        agent_data = json.loads(sys.argv[1])
    except Exception as e:
        print(f"Error parsing JSON: {e}", file=sys.stderr)
        sys.exit(1)

    project_id  = os.getenv("PROJECT_ID", "gls-training-486405")
    location    = os.getenv("LOCATION", "us-central1")
    bucket_name = f"{project_id}-adk-staging"

    # 1. Ensure staging bucket exists
    storage_client = storage.Client(project=project_id)
    bucket = storage_client.bucket(bucket_name)
    if not bucket.exists():
        bucket.create(location=location)
        logger.info(f"Created staging bucket: gs://{bucket_name}")

    vertexai.init(
        project=project_id,
        location=location,
        staging_bucket=f"gs://{bucket_name}",
    )

    # 2. Extract agent properties
    agent_id   = agent_data.get("id", "unknown-id")
    name       = agent_data.get("name", "Unnamed Agent")
    role       = agent_data.get("role", "")
    goal       = agent_data.get("goal", "")
    sys_prompt = agent_data.get("systemPrompt", "")
    tool_names = agent_data.get("tools", [])

    logger.info(f"🚀 Deploying ADK Agent: {name} (id={agent_id})")
    logger.info(f"   Tools: {tool_names}")

    # 3. Instantiate the agent locally for the AdkApp wrapper
    # We set env vars first to ensure GenAI configures itself properly in Vertex mode
    os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "1"
    os.environ["GOOGLE_CLOUD_PROJECT"] = project_id
    os.environ["GOOGLE_CLOUD_LOCATION"] = location

    agent = _create_egap_agent(
        agent_id=agent_id,
        name=name,
        system_prompt=sys_prompt,
        tool_names=tool_names,
    )

    # 4. Wrap the Agent in AdkApp (required by ReasoningEngine / Agent Engine metrics)
    app = AdkApp(
        agent=agent,
        enable_tracing=True,
        env_vars={
            "GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY": "true",
        },
        session_service_builder=InMemorySessionService,
        artifact_service_builder=InMemoryArtifactService,
        memory_service_builder=InMemoryMemoryService,
    )

    # 5. Deploy to Vertex AI Agent Engine (ReasoningEngine)
    #    No extra_packages needed — all code is inlined, and cloudpickle
    #    only references standard pip-installable packages.
    try:
        from vertexai import agent_engines

        remote_app = agent_engines.create(
            app,
            requirements=[
                "google-adk>=0.3.0",
                "google-cloud-aiplatform[agent_engines]>=1.62.0",
                "google-cloud-storage>=2.14.0",
                "google-genai>=1.0.0",
                "requests>=2.31.0",
                "opentelemetry-exporter-otlp-proto-http",
                "opentelemetry-exporter-gcp-logging",
                "opentelemetry-sdk",
            ],
            env_vars={
                "GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY": "true",
            },
            display_name=name,
            description=f"EGAP Agent: {role} — {goal}",
        )

        # 6. Print resource name to stdout (orchestrator reads it)
        print(remote_app.resource_name)
        logger.info(f"☁️ ADK Agent deployed: {remote_app.resource_name}")
        sys.exit(0)

    except Exception as e:
        print(f"ERROR: {str(e)}", file=sys.stderr)
        logger.error(f"❌ Deployment failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
