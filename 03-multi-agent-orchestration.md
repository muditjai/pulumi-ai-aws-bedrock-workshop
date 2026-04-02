# Module 3: Multi-agent orchestration

**Duration:** ~40 minutes

## What you'll learn

- Why you'd split work across multiple agents instead of building one monolithic agent
- How Agent-to-Agent (A2A) communication works on AgentCore
- How IAM permissions gate which agents can invoke which
- How to handle streaming responses between agents
- How sequential build dependencies work in Pulumi

## Why multiple agents?

A single agent with a dozen tools and a long system prompt can work, but it gets unwieldy fast. The LLM has to decide between too many options on every turn, and the system prompt becomes a wall of instructions competing for attention.

The alternative is to split work by specialty. An orchestrator agent handles incoming requests and decides whether to answer directly or hand off to a specialist. The specialist has a focused system prompt and can go deep on a narrow domain.

In this module, you'll build two agents:

- **Orchestrator**: Handles simple queries (greetings, basic questions) directly. Delegates complex analytical tasks to the specialist.
- **Specialist**: An analytical agent that gives thorough, detailed answers. It doesn't know about the orchestrator; it just answers whatever it's asked.

The orchestrator calls the specialist using `bedrock-agentcore:InvokeAgentRuntime`, which is an AWS API call. AgentCore manages the routing, and IAM controls who can call whom.

## How A2A communication works

When the orchestrator needs the specialist, it calls `InvokeAgentRuntime` with the specialist's ARN. AgentCore receives the request, verifies the orchestrator's IAM role has permission, and forwards the payload to the specialist container. The specialist processes the request and returns a response, which streams back to the orchestrator.

```
User
  ↓  "Analyze the trade-offs of microservices vs monoliths"
Orchestrator Agent
  ↓  (complex question → delegate)
  ↓  InvokeAgentRuntime(specialist_arn, payload)
Specialist Agent
  ↓  (detailed analysis)
  ↑  streaming response
Orchestrator Agent
  ↑  returns specialist's answer to user
```

The IAM permission that makes this work is `bedrock-agentcore:InvokeAgentRuntime`. The orchestrator's execution role gets this permission; the specialist's role does not. This is intentional: the specialist can't call back to the orchestrator and create a loop.

## Step 1: Create a new Pulumi project

```bash
mkdir 03-multi-agent && cd 03-multi-agent
pulumi new aws-typescript --name multi-agent --yes
```

Add the ESC environment to `Pulumi.dev.yaml`:

```yaml
environment:
  - pulumi-idp/auth
```

Install dependencies:

```bash
npm install @pulumi/aws@7.23.0
```

Set your unique stack name:

```bash
pulumi config set stackName agentcore-multi-<id>
```

## Step 2: Write the specialist agent

Create the specialist source directory:

```bash
mkdir -p agent-specialist-code
```

Create `agent-specialist-code/agent.py`:

```python
from strands import Agent
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()


def create_specialist_agent() -> Agent:
    """Create a specialist agent that handles specific analytical tasks"""
    system_prompt = """You are a specialist analytical agent.
    You are an expert at analyzing data and providing detailed insights.
    When asked questions, provide thorough, well-reasoned responses with specific details.
    Focus on accuracy and completeness in your answers."""

    return Agent(system_prompt=system_prompt, name="SpecialistAgent")


@app.entrypoint
async def invoke(payload=None):
    """Main entrypoint for specialist agent"""
    try:
        query = payload.get("prompt", "Hello") if payload else "Hello"
        agent = create_specialist_agent()
        response = agent(query)

        return {
            "status": "success",
            "agent": "specialist",
            "response": response.message["content"][0]["text"],
        }

    except Exception as e:
        return {"status": "error", "agent": "specialist", "error": str(e)}


if __name__ == "__main__":
    app.run()
```

The specialist is a plain Strands agent with no special tools. Its only job is to give detailed answers. The response includes `"agent": "specialist"` so you can tell where the answer came from when testing.

Create `agent-specialist-code/requirements.txt`:

```
strands-agents
boto3>=1.40.0
botocore>=1.40.0
bedrock-agentcore
```

Create `agent-specialist-code/Dockerfile`:

```dockerfile
FROM public.ecr.aws/docker/library/python:3.11-slim
WORKDIR /app

COPY requirements.txt requirements.txt
RUN pip install -r requirements.txt
RUN pip install aws-opentelemetry-distro>=0.10.1

RUN useradd -m -u 1000 bedrock_agentcore
USER bedrock_agentcore

EXPOSE 8080
EXPOSE 8000

COPY . .

CMD ["opentelemetry-instrument", "python", "-m", "agent"]
```

## Step 3: Write the orchestrator agent

```bash
mkdir -p agent-orchestrator-code
```

Create `agent-orchestrator-code/agent.py`:

```python
from strands import Agent, tool
from typing import Dict, Any
import boto3
import json
import os
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()

SPECIALIST_ARN = os.getenv("SPECIALIST_ARN")
if not SPECIALIST_ARN:
    raise EnvironmentError("SPECIALIST_ARN environment variable is required")


def invoke_specialist(query: str) -> str:
    """Helper function to invoke specialist agent using boto3"""
    try:
        region = os.getenv("AWS_REGION")
        if not region:
            raise EnvironmentError("AWS_REGION environment variable is required")
        agentcore_client = boto3.client("bedrock-agentcore", region_name=region)

        response = agentcore_client.invoke_agent_runtime(
            agentRuntimeArn=SPECIALIST_ARN,
            qualifier="DEFAULT",
            payload=json.dumps({"prompt": query}),
        )

        # Handle streaming response
        if "text/event-stream" in response.get("contentType", ""):
            result = ""
            for line in response["response"].iter_lines(chunk_size=10):
                if line:
                    line = line.decode("utf-8")
                    if line.startswith("data: "):
                        line = line[6:]
                    result += line
            return result

        elif response.get("contentType") == "application/json":
            content = []
            for chunk in response.get("response", []):
                content.append(chunk.decode("utf-8"))
            response_data = json.loads("".join(content))
            return json.dumps(response_data)

        else:
            response_body = response["response"].read()
            return response_body.decode("utf-8")

    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        return f"Error invoking specialist agent: {str(e)}\nDetails: {error_details}"


@tool
def call_specialist_agent(query: str) -> Dict[str, Any]:
    """
    Call the specialist agent for detailed analysis or complex tasks.
    Use this tool when you need expert analysis or detailed information.

    Args:
        query: The question or task to send to the specialist agent

    Returns:
        The specialist agent's response
    """
    result = invoke_specialist(query)
    return {"status": "success", "content": [{"text": result}]}


def create_orchestrator_agent() -> Agent:
    """Create the orchestrator agent with the tool to call specialist agent"""
    system_prompt = """You are an orchestrator agent.
    You can handle simple queries directly, but for complex analytical tasks,
    you should delegate to the specialist agent using the call_specialist_agent tool.

    Use the specialist agent when:
    - The query requires detailed analysis
    - The query is about complex topics
    - The user explicitly asks for expert analysis

    Handle simple queries (greetings, basic questions) yourself."""

    return Agent(
        tools=[call_specialist_agent],
        system_prompt=system_prompt,
        name="OrchestratorAgent",
    )


@app.entrypoint
async def invoke(payload=None):
    """Main entrypoint for orchestrator agent"""
    try:
        query = (
            payload.get("prompt", "Hello, how are you?")
            if payload
            else "Hello, how are you?"
        )
        agent = create_orchestrator_agent()
        response = agent(query)

        return {
            "status": "success",
            "agent": "orchestrator",
            "response": response.message["content"][0]["text"],
        }

    except Exception as e:
        return {"status": "error", "agent": "orchestrator", "error": str(e)}


if __name__ == "__main__":
    app.run()
```

The orchestrator reads `SPECIALIST_ARN` from an environment variable (set by Pulumi at deploy time). The `@tool` decorator on `call_specialist_agent` makes it available to the Strands agent as a callable tool. When the LLM decides a question is complex, it calls this tool, which triggers the A2A invocation.

The response handling has three branches because AgentCore can return different content types: event streams, JSON, or raw bytes. In practice, you'll usually get the streaming format.

Create the same `requirements.txt` and `Dockerfile` as the specialist (see `03-solution/typescript/agent-orchestrator-code/`).

## Step 4: Write the Pulumi infrastructure

The infrastructure doubles everything from Module 1: two S3 buckets, two ECR repos, two IAM roles, two CodeBuild projects, two Lambda triggers, and two AgentCore Runtimes.

The full `index.ts` is in `03-solution/typescript/index.ts`. Here are the parts that are new.

### A2A IAM policy

The orchestrator's execution role gets an extra policy that lets it invoke other agent runtimes:

```typescript
const orchestratorInvokeSpecialist = new aws.iam.RolePolicy(
  "orchestrator_invoke_specialist",
  {
    name: "OrchestratorInvokeSpecialistPolicy",
    role: orchestratorExecution.id,
    policy: pulumi.jsonStringify({
      Version: "2012-10-17",
      Statement: [{
        Sid: "InvokeSpecialistRuntime",
        Effect: "Allow",
        Action: ["bedrock-agentcore:InvokeAgentRuntime"],
        Resource: pulumi.all([currentRegion, currentIdentity]).apply(
          ([region, identity]) =>
            `arn:aws:bedrock-agentcore:${region.region}:${identity.accountId}:runtime/*`,
        ),
      }],
    }),
  },
);
```

The specialist's role does not get this permission. One-directional only.

### Sequential builds

The specialist must be built and deployed before the orchestrator, because the orchestrator needs the specialist's ARN as an environment variable:

```typescript
const triggerBuildOrchestrator = new aws.lambda.Invocation(
  "trigger_build_orchestrator",
  {
    functionName: buildTriggerFunction.name,
    input: /* ... */,
    triggers: { /* ... */ },
  },
  {
    dependsOn: [
      // ... other dependencies ...
      triggerBuildSpecialist,  // specialist must build first
    ],
  },
);
```

### Passing the specialist ARN

The orchestrator runtime gets the specialist's ARN as an environment variable:

```typescript
const orchestratorAgent = new aws.bedrock.AgentcoreAgentRuntime("orchestrator", {
  // ...
  environmentVariables: {
    AWS_REGION: awsRegion,
    AWS_DEFAULT_REGION: awsRegion,
    SPECIALIST_ARN: specialistAgent.agentRuntimeArn,
  },
}, {
  dependsOn: [
    specialistAgent,  // specialist runtime must exist first
    triggerBuildOrchestrator,
    orchestratorExecutionRolePolicy,
    orchestratorInvokeSpecialist,
    orchestratorExecutionManaged,
  ],
});
```

Pulumi resolves `specialistAgent.agentRuntimeArn` automatically once the specialist is created.

## Step 5: Deploy

```bash
pulumi up
```

This takes longer than Module 1 since two agents are being built sequentially. Expect 10-15 minutes.

## Step 6: Test

Grab the orchestrator ARN:

```bash
export ORCH_ARN=$(pulumi stack output orchestratorRuntimeArn)
```

Copy `test_multi_agent.py` from the solution folder and run:

```bash
python test_multi_agent.py $ORCH_ARN
```

Try two types of queries:

1. A simple greeting: `"Hello, how are you?"` — the orchestrator handles this directly
2. A complex question: `"Analyze the trade-offs between microservices and monolithic architectures"` — the orchestrator delegates to the specialist

You can tell which agent answered by checking the `"agent"` field in the response.

## Try it yourself

**Rewrite the delegation logic.** Open `agent-orchestrator-code/agent.py` and change the system prompt. For example, make the orchestrator always delegate math questions but handle history questions itself. Redeploy and test with prompts that probe the new boundary. How reliably does the LLM follow your routing instructions?

**Change the specialist's personality.** Edit `agent-specialist-code/agent.py` and change the system prompt to be more opinionated, shorter, or domain-specific (e.g., "You are a cybersecurity expert"). Redeploy and send complex queries through the orchestrator. The specialist's new tone should come through in the orchestrator's response.

**Test the one-way boundary.** The specialist can't call the orchestrator because it lacks the `InvokeAgentRuntime` IAM permission. Try invoking the specialist directly to confirm it works on its own:

```bash
export SPEC_ARN=$(pulumi stack output specialistRuntimeArn)
python3 -c "
import boto3, json
client = boto3.client('bedrock-agentcore', region_name='us-east-1')
r = client.invoke_agent_runtime(
    agentRuntimeArn='$SPEC_ARN',
    qualifier='DEFAULT',
    payload=json.dumps({'prompt': 'What are the pros and cons of event-driven architecture?'}),
)
print(json.loads(r['response'].read().decode())['response'][:500])
"
```

## What you learned

- Splitting agents by specialty keeps system prompts focused and LLM decisions cleaner
- A2A communication uses `bedrock-agentcore:InvokeAgentRuntime` with standard IAM permissions
- The orchestrator discovers the specialist through an environment variable containing its ARN
- Pulumi's `dependsOn` enforces the build and deploy order: specialist first, then orchestrator
- IAM permissions are one-directional: the orchestrator can call the specialist, but not the reverse
- AgentCore supports streaming responses between agents

Next up: [Module 4 — The full stack: weather agent with tools and memory](04-full-stack-weather-agent.md)
