---
---
# Module 4: The full stack — weather agent with tools and memory

**Duration:** ~40 minutes

## What you'll learn

- What AgentCore's managed tools are (Browser, Code Interpreter, Memory) and why they exist
- How to wire multiple tools into a single agent
- How the async task pattern works (return immediately, process in background)
- How to set up observability with CloudWatch vended logs and X-Ray traces
- How the Memory API stores and retrieves structured data

## AgentCore managed tools

In the previous modules, your agents had no tools (Module 1), three simple math tools (Module 2), or one agent-calling tool (Module 3). This module adds real tools that interact with the outside world.

AgentCore provides three managed tools as first-class resources:

**Browser** is a headless Chrome instance that your agent can control. It connects via WebSocket and supports full page navigation, clicking, typing, and scraping. The browser runs inside AWS, not on your laptop, which means it can access the same URLs consistently and you don't have to package a browser binary into your container.

**Code Interpreter** is a sandboxed Python runtime. Your agent generates Python code, sends it to Code Interpreter, and gets the output back. Useful for data transformation, calculations, or anything where you'd rather run code than have the LLM try to compute the answer from text.

**Memory** is a persistent event store. You write events with payloads (arbitrary JSON blobs) tagged with actor IDs and session IDs, and read them back later. The agent code treats it like a simple key-value store for preferences, past interactions, or any context that should survive between invocations. Events expire after a configurable TTL (30 days in this workshop).

These are managed services, not libraries bundled into your container. Pulumi creates them as standalone AWS resources, and your agent connects to them at runtime using IDs passed in as environment variables.

## The weather agent workflow

Here's what the agent does end-to-end when you ask "What should I do this weekend in Richmond VA?":

1. Extracts the city name from your query
2. Uses the Browser tool to scrape an 8-day forecast from weather.gov
3. Generates Python code to classify each day as GOOD, OK, or POOR based on temperature and conditions
4. Sends that code to Code Interpreter and gets the classification results
5. Reads activity preferences from Memory (hiking for good weather, museums for poor weather, etc.)
6. Matches the classified days to preferred activities
7. Writes a Markdown report to S3

The agent returns immediately with a "processing started" message. The actual work runs as an async background task. This is a common pattern for agents that take a while to finish: you don't want the caller waiting 10 minutes for an HTTP response.

## Step 1: Create a new Pulumi project

<div class="lang-tabs" markdown="1">

<div class="lang-tab" data-lang="typescript" markdown="1">

```bash
mkdir 04-weather-agent && cd 04-weather-agent
pulumi new aws-typescript --name weather-agent --yes
```

</div>

<div class="lang-tab" data-lang="python" markdown="1">

```bash
mkdir 04-weather-agent && cd 04-weather-agent
pulumi new aws-python --name weather-agent --yes
```

</div>

</div>

Add the ESC environment to `Pulumi.dev.yaml`:

```yaml
environment:
  - pulumi-idp/auth
```

Install dependencies:

<div class="lang-tabs" markdown="1">

<div class="lang-tab" data-lang="typescript" markdown="1">

```bash
npm install @pulumi/aws@7.23.0
```

</div>

<div class="lang-tab" data-lang="python" markdown="1">

Dependencies are managed in `pyproject.toml` — no install step needed.

</div>

</div>

Set your unique stack name:

```bash
pulumi config set stackName agentcore-weather-<id>
```

## Step 2: Write the weather agent code

Create the agent source directory:

```bash
mkdir -p agent-code
```

The agent code is the most complex Python in this workshop. The full file is at `04-solution/typescript/agent-code/weather_agent.py`. Here are the key pieces.

### Tool definitions

Each tool is a function decorated with `@tool` from Strands:

```python
@tool
async def get_weather_data(city: str) -> Dict[str, Any]:
    """Get weather data for a city using browser automation"""
    browser_session, bedrock_chat, browser_client = await initialize_browser_session()

    task = f"""Extract 8-Day Weather Forecast for {city} from weather.gov..."""
    result = await run_browser_task(browser_session, bedrock_chat, task)

    browser_client.stop()
    return {"status": "success", "content": [{"text": result}]}
```

The browser tool uses the `browser-use` library with `BrowserClient` from the AgentCore SDK. The client connects to the managed Browser resource using its ID (from the `BROWSER_ID` environment variable), and `browser-use` drives the headless Chrome session via a second LLM call (Claude Sonnet) that decides where to click, what to type, and what to scrape.

```python
@tool
def execute_code(python_code: str) -> Dict[str, Any]:
    """Execute Python code using AgentCore Code Interpreter"""
    code_client = CodeInterpreter(AWS_REGION)
    code_client.start(identifier=CODE_INTERPRETER_ID)
    response = code_client.invoke(
        "executeCode",
        {"code": python_code, "language": "python", "clearContext": True},
    )
    # ...
```

```python
@tool
def get_activity_preferences() -> Dict[str, Any]:
    """Get activity preferences from memory"""
    client = MemoryClient(region_name=AWS_REGION)
    response = client.list_events(
        memory_id=MEMORY_ID,
        actor_id="user123",
        session_id="session456",
        max_results=50,
        include_payload=True,
    )
    # ...
```

### The async pattern

The entrypoint returns immediately and kicks off the real work as a background task:

```python
@app.entrypoint
async def invoke(payload=None):
    query = payload.get("prompt")
    asyncio.create_task(async_main(query))
    return {
        "status": "Started",
        "message": "Processing started... Check CloudWatch logs and S3 for results."
    }
```

The caller gets a quick response. The heavy lifting (browser scraping, code execution, memory reads, S3 writes) happens in `async_main()`, which runs until completion in the background.

### The system prompt

The system prompt tells the agent to follow the 7-step workflow sequentially:

```python
system_prompt = f"""You are a Weather-Based Activity Planning Assistant.

When a user asks about activities for a location, follow below steps sequentially:
1. Extract city from user query
2. Call get_weather_data(city) to get weather information
3. Call generate_analysis_code(weather_data) to create classification code
4. Call execute_code(python_code) to classify days as GOOD/OK/POOR
5. Call get_activity_preferences() to get user preferences
6. Generate Activity Recommendations based on weather and preferences
7. Write results to S3 bucket: {RESULTS_BUCKET}

IMPORTANT: Provide complete recommendations and end your response.
Do NOT ask follow-up questions or wait for additional input."""
```

## Complete solution files

### Weather agent

<div class="lang-tabs" markdown="1">

<div class="lang-tab" data-lang="typescript" markdown="1">

{% highlight python %}
{% include_relative 04-solution/typescript/agent-code/weather_agent.py %}
{% endhighlight %}

</div>

<div class="lang-tab" data-lang="python" markdown="1">

{% highlight python %}
{% include_relative 04-solution/python/agent-code/weather_agent.py %}
{% endhighlight %}

</div>

</div>

Create `agent-code/requirements.txt`:

```text
strands-agents
strands-agents-tools
uv
boto3
bedrock-agentcore
bedrock-agentcore-starter-toolkit
browser-use==0.3.2
langchain-aws>=0.1.0
rich
```

Create `agent-code/Dockerfile`:

```dockerfile
FROM public.ecr.aws/docker/library/python:3.11-slim

WORKDIR /app

COPY requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt && \
    pip install --no-cache-dir aws-opentelemetry-distro==0.10.1

RUN useradd -m -u 1000 bedrock_agentcore
USER bedrock_agentcore

EXPOSE 8080
EXPOSE 8000

COPY . .

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/ping || exit 1

CMD ["opentelemetry-instrument", "python", "-m", "weather_agent"]
```

## Step 3: Create the memory initialization Lambda

The Memory tool starts empty. We need to seed it with activity preferences so the agent has something to work with.

```bash
mkdir -p lambda/init-memory
```

Create `lambda/init-memory/index.py`:

```python
import json
import logging
from datetime import datetime, timezone

import boto3

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)


def handler(event, _context):
    LOGGER.info("Received event: %s", json.dumps(event))

    memory_id = event["memoryId"]
    region = event.get("region")

    client = boto3.client("bedrock-agentcore", region_name=region)

    activity_preferences = {
        "good_weather": [
            "hiking", "beach volleyball", "outdoor picnic",
            "farmers market", "gardening", "photography", "bird watching",
        ],
        "ok_weather": ["walking tours", "outdoor dining", "park visits", "museums"],
        "poor_weather": ["indoor museums", "shopping", "restaurants", "movies"],
    }

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    response = client.create_event(
        memoryId=memory_id,
        actorId="user123",
        sessionId="session456",
        eventTimestamp=timestamp,
        payload=[{"blob": json.dumps(activity_preferences)}],
    )

    event_id = response.get("eventId", "unknown")
    LOGGER.info("Memory initialized with event %s", event_id)

    return {"memoryId": memory_id, "eventId": event_id, "status": "initialized"}
```

Pulumi invokes this Lambda after the Memory resource is created. It writes one event containing the activity preferences as a JSON blob. The agent reads this back using `MemoryClient.list_events()` with the same `actor_id` and `session_id`.

Also create the `lambda/build-trigger/index.py` (same as Module 1).

## Step 4: Write the Pulumi infrastructure

The infrastructure extends Module 1 with three new AgentCore tool resources, a results S3 bucket, the memory init Lambda, and observability configuration.

The full solution is in `04-solution/typescript/index.ts` (TypeScript) and `04-solution/python/__main__.py` (Python). Here are the new parts.

### Infrastructure

<div class="lang-tabs" markdown="1">

<div class="lang-tab" data-lang="typescript" markdown="1">

{% highlight typescript %}
{% include_relative 04-solution/typescript/index.ts %}
{% endhighlight %}

</div>

<div class="lang-tab" data-lang="python" markdown="1">

{% highlight python %}
{% include_relative 04-solution/python/__main__.py %}
{% endhighlight %}

</div>

</div>

### AgentCore tools

<div class="lang-tabs" markdown="1">

<div class="lang-tab" data-lang="typescript" markdown="1">

```typescript
const browser = new aws.bedrock.AgentcoreBrowser("browser", {
  name: `${stackName.replace(/-/g, "_")}_browser`,
  description: "Browser tool for weather agent",
  networkConfiguration: { networkMode: networkMode },
});

const codeInterpreter = new aws.bedrock.AgentcoreCodeInterpreter("code_interpreter", {
  name: `${stackName.replace(/-/g, "_")}_code_interpreter`,
  description: "Code interpreter for weather data analysis",
  networkConfiguration: { networkMode: networkMode },
});

const memory = new aws.bedrock.AgentcoreMemory("memory", {
  name: `${stackName.replace(/-/g, "_")}_${memoryName}`,
  description: "Memory for weather agent preferences",
  eventExpiryDuration: 30,
});
```

</div>

<div class="lang-tab" data-lang="python" markdown="1">

```python
browser = aws.bedrock.AgentcoreBrowser(
    "browser",
    name=f"{stack_name.replace('-', '_')}_browser",
    description="Browser tool for weather agent",
    network_configuration={"network_mode": network_mode},
)

code_interpreter = aws.bedrock.AgentcoreCodeInterpreter(
    "code_interpreter",
    name=f"{stack_name.replace('-', '_')}_code_interpreter",
    description="Code interpreter for weather data analysis",
    network_configuration={"network_mode": network_mode},
)

memory = aws.bedrock.AgentcoreMemory(
    "memory",
    name=f"{stack_name.replace('-', '_')}_{memory_name}",
    description="Memory for weather agent preferences",
    event_expiry_duration=30,
)
```

</div>

</div>

Each tool is a standalone AWS resource. The agent connects to them using their IDs.

### Passing tool IDs to the agent

<div class="lang-tabs" markdown="1">

<div class="lang-tab" data-lang="typescript" markdown="1">

```typescript
const weatherAgent = new aws.bedrock.AgentcoreAgentRuntime("weather_agent", {
  // ...
  environmentVariables: {
    AWS_REGION: awsRegion,
    AWS_DEFAULT_REGION: awsRegion,
    RESULTS_BUCKET: results.id,
    BROWSER_ID: browser.browserId,
    CODE_INTERPRETER_ID: codeInterpreter.codeInterpreterId,
    MEMORY_ID: memory.id,
  },
});
```

</div>

<div class="lang-tab" data-lang="python" markdown="1">

```python
weather_agent = aws.bedrock.AgentcoreAgentRuntime(
    "weather_agent",
    # ...
    environment_variables={
        "AWS_REGION": aws_region,
        "AWS_DEFAULT_REGION": aws_region,
        "RESULTS_BUCKET": results.id,
        "BROWSER_ID": browser.browser_id,
        "CODE_INTERPRETER_ID": code_interpreter.code_interpreter_id,
        "MEMORY_ID": memory.id,
    },
)
```

</div>

</div>

### Observability

CloudWatch vended logs and X-Ray traces give you visibility into the agent's behavior:

<div class="lang-tabs" markdown="1">

<div class="lang-tab" data-lang="typescript" markdown="1">

```typescript
const agentRuntimeLogs = new aws.cloudwatch.LogGroup("agent_runtime_logs", {
  name: pulumi.interpolate`/aws/vendedlogs/bedrock-agentcore/${weatherAgent.agentRuntimeId}`,
  retentionInDays: 14,
});

// Log delivery source → destination → delivery pipeline
const logs = new aws.cloudwatch.LogDeliverySource("logs", {
  name: pulumi.interpolate`${weatherAgent.agentRuntimeId}-logs-src`,
  logType: "APPLICATION_LOGS",
  resourceArn: weatherAgent.agentRuntimeArn,
});

// Similar setup for TRACES → X-Ray
```

</div>

<div class="lang-tab" data-lang="python" markdown="1">

```python
agent_runtime_logs = aws.cloudwatch.LogGroup(
    "agent_runtime_logs",
    name=pulumi.Output.concat(
        "/aws/vendedlogs/bedrock-agentcore/", weather_agent.agent_runtime_id
    ),
    retention_in_days=14,
)

logs = aws.cloudwatch.LogDeliverySource(
    "logs",
    name=pulumi.Output.concat(weather_agent.agent_runtime_id, "-logs-src"),
    log_type="APPLICATION_LOGS",
    resource_arn=weather_agent.agent_runtime_arn,
)

# Similar setup for TRACES → X-Ray
```

</div>

</div>

Vended logs are different from regular CloudWatch logs. AgentCore produces them, and you configure a delivery pipeline to route them to a log group. The same pattern works for X-Ray traces.

## Step 5: Deploy

```bash
pulumi up
```

This takes 5-10 minutes. In addition to the CodeBuild and runtime, you'll see the Browser, Code Interpreter, and Memory resources being created.

## Step 6: Test your deployment

Copy `test_weather_agent.py` from the solution folder and run:

```bash
export AGENT_ARN=$(pulumi stack output agentRuntimeArn)
python test_weather_agent.py $AGENT_ARN
```

The test script runs through the full pipeline:

1. **Runtime status** — is the AgentCore runtime READY?
2. **Agent invocation** — does the agent accept a request? (first call may take 1-2 min for cold start)
3. **S3 results** — waits for the Markdown report to appear in S3 (3-5 min)

When everything works, you'll see:

```text
[1/3] Checking runtime status...
      PASS - Runtime is READY
[2/3] Invoking agent (first call may take 1-2 min for cold start)...
      PASS - Agent responded: status=Started
[3/3] Waiting for Markdown report in S3...
      (The agent scrapes weather.gov, classifies days,
       reads memory, and writes a report. ~3-5 min.)
      ...1m00s elapsed, still processing
      ...2m30s elapsed, still processing
      PASS - Markdown report found: results.md

      --- Report preview ---
      # Weekend Activity Recommendations for Richmond, VA
      ...

ALL CHECKS PASSED (3/3)
```

The report contains weather forecasts, day classifications (GOOD/OK/POOR), and activity recommendations matched to the preferences stored in Memory.

You can also watch the agent work in real time via CloudWatch Logs:

```bash
export RUNTIME_ID=$(pulumi stack output agentRuntimeId)
aws logs tail "/aws/bedrock-agentcore/runtimes/${RUNTIME_ID}-DEFAULT" --follow --region us-east-1
```

You'll see each step: browser session connecting, weather data scraped, Python code generated and executed, memory read, and the S3 write.

## Try it yourself

**Ask about a different city.** Invoke the agent again with a different location:

```bash
python3 -c "
import boto3, json
from botocore.config import Config
client = boto3.client('bedrock-agentcore', region_name='us-east-1',
    config=Config(read_timeout=180, retries={'max_attempts': 0}))
r = client.invoke_agent_runtime(
    agentRuntimeArn='$(pulumi stack output agentRuntimeArn)',
    qualifier='DEFAULT',
    payload=json.dumps({'prompt': 'What should I do this weekend in Seattle WA?'}),
)
print(json.loads(r['response'].read().decode()))
"
```

Wait a few minutes and check S3 again. The new report should overwrite (or sit alongside) the previous one.

**Change the activity preferences.** The preferences live in Memory, seeded by the init Lambda. Open `lambda/init-memory/index.py` and change the activity lists. Add "surfing" to good weather, or "escape rooms" to poor weather. Redeploy with `pulumi up` to re-seed Memory, then invoke the agent again. The recommendations in the report should reflect your new preferences.

**Tweak the classification thresholds.** The agent generates Python code to classify days as GOOD/OK/POOR based on temperature and conditions. Open `agent-code/weather_agent.py` and find the `generate_analysis_code` tool. Edit the rules in the prompt (e.g., change the GOOD range from 65-80 to 55-90). Redeploy and see how the classifications change.

**Read the S3 report as Markdown.** If you have a Markdown viewer, pipe the report through it:

```bash
aws s3 cp s3://$(pulumi stack output resultsBucketName)/results.md - | less
```

## What you learned

- AgentCore's Browser, Code Interpreter, and Memory are managed AWS resources, not libraries in your container
- Tool IDs are passed to the agent as environment variables at deploy time
- The async task pattern returns immediately and processes work in the background
- CloudWatch vended logs and X-Ray traces require a delivery pipeline (source → destination → delivery)
- The Memory API stores events tagged with actor IDs and session IDs, with configurable TTL
- A Lambda function can seed Memory with initial data during deployment

Next up: [Module 5 — Housekeeping](05-housekeeping.md)
