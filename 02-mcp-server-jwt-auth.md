---
---
# Module 2: Hosting an MCP server with JWT auth

**Duration:** ~45 minutes

## What you'll learn

- What the Model Context Protocol (MCP) is and why it matters for agent-tool communication
- How to build an MCP server with FastMCP in Python
- How to secure it with JWT tokens from Amazon Cognito
- How to use Pulumi secrets for sensitive config
- How AgentCore's Policy Engine enforces access control using Cedar policies

## What is MCP?

The Model Context Protocol is an open standard for how agents discover and call tools. Without MCP, every agent framework invents its own way to connect to tools. With MCP, a tool exposes a standard HTTP endpoint, and any MCP-compatible agent can list the available tools and call them.

AgentCore supports MCP natively. When you set `serverProtocol: "MCP"` on a runtime, AgentCore knows your container speaks MCP and routes requests accordingly.

The transport we use here is Stateless Streamable HTTP. Each request is independent (no persistent WebSocket connection), and the server identifies sessions via an `MCP-Session-Id` header. This makes the server easy to scale since there's no session state to track.

## Why JWT auth?

If you deploy an MCP server without authentication, anyone who knows the URL can call your tools. That's fine for local development, but you wouldn't do it in production.

We'll use Amazon Cognito as the identity provider. Cognito issues JWT tokens, and AgentCore validates them at the gateway before forwarding requests to your MCP server. Your server code never has to deal with auth; AgentCore handles it.

## Step 1: Create a new Pulumi project

<div class="lang-tabs" markdown="1">

<div class="lang-tab" data-lang="typescript" markdown="1">

```bash
mkdir 02-mcp-server && cd 02-mcp-server
pulumi new aws-typescript --name mcp-server --yes
```

</div>

<div class="lang-tab" data-lang="python" markdown="1">

```bash
mkdir 02-mcp-server && cd 02-mcp-server
pulumi new aws-python --name mcp-server --yes
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

Set your unique stack name and store the test password in the shared ESC environment:

```bash
pulumi config set stackName agentcore-mcp-<id>
pulumi env set pulumi-idp/auth 'pulumiConfig.mcp-server-agentcore-runtime:testPassword' '"'"'"TestPassword123"'"'"' --secret
```

## Step 2: Write the MCP server

Create the server source directory:

```bash
mkdir -p mcp-server-code
```

Create `mcp-server-code/mcp_server.py`:

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP(host="0.0.0.0", stateless_http=True)


@mcp.tool()
def add_numbers(a: int, b: int) -> int:
    """Add two numbers together"""
    return a + b


@mcp.tool()
def multiply_numbers(a: int, b: int) -> int:
    """Multiply two numbers together"""
    return a * b


@mcp.tool()
def greet_user(name: str) -> str:
    """Greet a user by name"""
    return f"Hello, {name}! Nice to meet you."


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
```

That's the entire MCP server. Three tools, about 20 lines. The `@mcp.tool()` decorator registers each function as an MCP-callable tool. `stateless_http=True` tells FastMCP to use the Streamable HTTP transport.

Create `mcp-server-code/requirements.txt`:

```text
mcp>=1.10.0
boto3
bedrock-agentcore
```

Create `mcp-server-code/Dockerfile`:

```dockerfile
FROM public.ecr.aws/docker/library/python:3.11-slim
WORKDIR /app

COPY requirements.txt requirements.txt
RUN pip install -r requirements.txt

# Create non-root user
RUN useradd -m -u 1000 bedrock_agentcore
USER bedrock_agentcore

EXPOSE 8000

COPY . .

CMD ["python", "-m", "mcp_server"]
```

Notice this Dockerfile is simpler than the agent one. No OpenTelemetry, and it only exposes port 8000 (the MCP HTTP endpoint). The MCP server doesn't need the agent runtime wrapper since it speaks HTTP directly.

## Step 3: Write the Pulumi infrastructure

The infrastructure is similar to Module 1, with two additions: Cognito for JWT auth and the `protocolConfiguration` on the runtime.

The full solution is in `02-solution/typescript/index.ts` (TypeScript) and `02-solution/python/__main__.py` (Python). Here are the new parts.

## Complete solution files

### MCP server

<div class="lang-tabs" markdown="1">

<div class="lang-tab" data-lang="typescript" markdown="1">

{% highlight python %}
{% include_relative 02-solution/typescript/mcp-server-code/mcp_server.py %}
{% endhighlight %}

</div>

<div class="lang-tab" data-lang="python" markdown="1">

{% highlight python %}
{% include_relative 02-solution/python/mcp-server-code/mcp_server.py %}
{% endhighlight %}

</div>

</div>

### Infrastructure

<div class="lang-tabs" markdown="1">

<div class="lang-tab" data-lang="typescript" markdown="1">

{% highlight typescript %}
{% include_relative 02-solution/typescript/index.ts %}
{% endhighlight %}

</div>

<div class="lang-tab" data-lang="python" markdown="1">

{% highlight python %}
{% include_relative 02-solution/python/__main__.py %}
{% endhighlight %}

</div>

</div>

### Cognito setup

<div class="lang-tabs" markdown="1">

<div class="lang-tab" data-lang="typescript" markdown="1">

```typescript
const mcpUserPool = new aws.cognito.UserPool("mcp_user_pool", {
  name: `${stackName}-user-pool`,
  passwordPolicy: {
    minimumLength: 8,
    requireUppercase: false,
    requireLowercase: false,
    requireNumbers: false,
    requireSymbols: false,
  },
  schemas: [{
    name: "email",
    attributeDataType: "String",
    required: false,
    mutable: true,
  }],
});

const mcpClient = new aws.cognito.UserPoolClient("mcp_client", {
  name: `${stackName}-client`,
  userPoolId: mcpUserPool.id,
  explicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
  generateSecret: false,
  preventUserExistenceErrors: "ENABLED",
});

const testUser = new aws.cognito.User("test_user", {
  userPoolId: mcpUserPool.id,
  username: "testuser",
  messageAction: "SUPPRESS",
});
```

</div>

<div class="lang-tab" data-lang="python" markdown="1">

```python
mcp_user_pool = aws.cognito.UserPool(
    "mcp_user_pool",
    name=f"{stack_name}-user-pool",
    password_policy={
        "minimum_length": 8,
        "require_uppercase": False,
        "require_lowercase": False,
        "require_numbers": False,
        "require_symbols": False,
    },
    schemas=[{
        "name": "email",
        "attribute_data_type": "String",
        "required": False,
        "mutable": True,
    }],
)

mcp_client = aws.cognito.UserPoolClient(
    "mcp_client",
    name=f"{stack_name}-client",
    user_pool_id=mcp_user_pool.id,
    explicit_auth_flows=["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    generate_secret=False,
    prevent_user_existence_errors="ENABLED",
)

test_user = aws.cognito.User(
    "test_user",
    user_pool_id=mcp_user_pool.id,
    username="testuser",
    message_action="SUPPRESS",
)
```

</div>

</div>

A Lambda function sets the test user's password using `AdminSetUserPassword`, since Cognito doesn't let you set a permanent password directly during user creation. The password comes from the Pulumi secret you set earlier.

### MCP runtime with JWT authorizer

<div class="lang-tabs" markdown="1">

<div class="lang-tab" data-lang="typescript" markdown="1">

```typescript
const mcpServer = new aws.bedrock.AgentcoreAgentRuntime("mcp_server", {
  agentRuntimeName: runtimeName,
  description: description,
  roleArn: agentExecution.arn,
  agentRuntimeArtifact: {
    containerConfiguration: {
      containerUri: pulumi.interpolate`${serverEcr.repositoryUrl}:${imageTag}`,
    },
  },
  networkConfiguration: { networkMode: networkMode },
  protocolConfiguration: {
    serverProtocol: "MCP",
  },
  authorizerConfiguration: {
    customJwtAuthorizer: {
      allowedClients: [mcpClient.id],
      discoveryUrl: pulumi.all([currentRegion, mcpUserPool.id]).apply(
        ([region, userPoolId]) =>
          `https://cognito-idp.${region.region}.amazonaws.com/${userPoolId}/.well-known/openid-configuration`,
      ),
    },
  },
  environmentVariables: mergedEnvVars,
});
```

</div>

<div class="lang-tab" data-lang="python" markdown="1">

```python
mcp_server = aws.bedrock.AgentcoreAgentRuntime(
    "mcp_server",
    agent_runtime_name=runtime_name,
    description=description,
    role_arn=agent_execution.arn,
    agent_runtime_artifact={
        "container_configuration": {
            "container_uri": pulumi.Output.concat(
                server_ecr.repository_url, ":", image_tag
            ),
        }
    },
    network_configuration={"network_mode": network_mode},
    protocol_configuration={"server_protocol": "MCP"},
    authorizer_configuration={
        "custom_jwt_authorizer": {
            "allowed_clients": [mcp_client.id],
            "discovery_url": pulumi.Output.all(
                current_region, mcp_user_pool.id
            ).apply(
                lambda args: f"https://cognito-idp.{args[0].name}.amazonaws.com/{args[1]}/.well-known/openid-configuration"
            ),
        }
    },
    environment_variables=merged_env_vars,
)
```

</div>

</div>

Two things are different from Module 1. `protocolConfiguration.serverProtocol` is set to `"MCP"`, which tells AgentCore this is an MCP server, not a regular agent. And `authorizerConfiguration.customJwtAuthorizer` points to the Cognito OIDC discovery URL and restricts access to our app client ID.

## Step 4: Deploy

```bash
pulumi up
```

Same 5-10 minute wait for CodeBuild. At the end, Pulumi outputs the runtime ARN, Cognito client ID, and a handy `getTokenCommand`.

## Step 5: Get a JWT token and test

First, get a token from Cognito. You can use the provided `get_token.py` script (copy from `02-solution/typescript/get_token.py`):

```bash
export CLIENT_ID=$(pulumi stack output cognitoUserPoolClientId)
export REGION=$(pulumi stack output cognitoDiscoveryUrl | grep -oP '(?<=cognito-idp\.)[^.]+')
python get_token.py $CLIENT_ID testuser 'TestPassword123' $REGION
```

This prints a JWT token. Export it:

```bash
export JWT_TOKEN="<paste the token here>"
```

Now test the MCP server. Copy `test_mcp_server.py` from the solution folder and run:

```bash
export AGENT_ARN=$(pulumi stack output agentRuntimeArn)
python test_mcp_server.py $AGENT_ARN $JWT_TOKEN
```

You should see the three tools listed and their results:
- `add_numbers(5, 3)` returns `8`
- `multiply_numbers(4, 7)` returns `28`
- `greet_user('Alice')` returns `Hello, Alice! Nice to meet you.`

Try calling without the token (or with a fake one) and you'll get an authorization error. The JWT authorizer is doing its job.

### Try it yourself

**Add a new tool.** Open `mcp-server-code/mcp_server.py` and add a fourth tool. Something like:

```python
@mcp.tool()
def reverse_string(text: str) -> str:
    """Reverse a string"""
    return text[::-1]
```

Redeploy with `pulumi up`, get a fresh token, and call your new tool with the test script. MCP auto-discovers tools, so the client picks it up without any config changes.

**Break the auth on purpose.** Grab a token, wait for it to expire (1 hour), and try again. Or tamper with the token by changing a character in the middle. See what error AgentCore returns. Understanding the failure modes helps when debugging real deployments.

## Policy enforcement with Cedar

Now that your MCP server is secured with JWT, let's add another layer: a Policy Engine that controls which tools each user can call.

### What is the Policy Engine?

The AgentCore Policy Engine sits between agents (or users) and tools. It evaluates every tool call against a set of Cedar policies and decides whether to allow or deny the request. Cedar is an open-source policy language developed by AWS, originally used in Amazon Verified Permissions.

The key idea is default-deny. If no policy explicitly permits a request, it's denied. This means you define what's allowed, and everything else is blocked.

### How it works

```text
Agent/User calls tool
    ↓
AgentCore Gateway receives request
    ↓
Policy Engine evaluates Cedar policies
    ↓
ALLOW → tool executes normally
DENY  → request blocked, error returned
```

Policies have three components:
- **Principal**: Who is making the request (identified by JWT `sub` claim)
- **Action**: Which tool is being called (e.g., `add_numbers`)
- **Resource**: Which Gateway ARN the request targets

### Step 6: Create a Policy Engine

```bash
aws bedrock-agentcore-control create-policy-engine \
  --name workshop-policy-engine \
  --description "Policy engine for MCP workshop"
```

Note the `policyEngineId` from the response. You'll need it for the next steps.

### Step 7: Add a Cedar policy

Let's create a policy that only allows calling `add_numbers` and `greet_user`, but blocks `multiply_numbers`:

```bash
aws bedrock-agentcore-control create-policy \
  --policy-engine-id <YOUR_POLICY_ENGINE_ID> \
  --name allow-add-and-greet \
  --validation-mode FAIL_ON_ANY_FINDINGS \
  --description "Allow add_numbers and greet_user only" \
  --definition '{
    "cedar": {
      "statement": "permit(principal is AgentCore::OAuthUser, action in [AgentCore::Action::\"add_numbers\", AgentCore::Action::\"greet_user\"], resource == AgentCore::Gateway::\"<YOUR_GATEWAY_ARN>\");"
    }
  }'
```

Replace `<YOUR_GATEWAY_ARN>` with your MCP server's runtime ARN.

This Cedar policy reads: "Allow any authenticated OAuth user to call `add_numbers` and `greet_user` on this specific gateway." Since the default is deny, `multiply_numbers` is implicitly blocked.

### Step 8: Associate the Policy Engine with your Gateway

You can also generate policies from natural language instead of writing Cedar by hand:

```bash
aws bedrock-agentcore-control start-policy-generation \
  --policy-engine-id <YOUR_POLICY_ENGINE_ID> \
  --policy-description "Allow authenticated users to add numbers and greet users, but deny multiplication" \
  --gateway-arn <YOUR_GATEWAY_ARN>
```

The service analyzes your gateway's tools and generates a valid Cedar policy. Generated policies expire after 7 days, so review and create them promptly.

### Step 9: Test in LOG_ONLY mode

First, associate the policy engine with your gateway in `LOG_ONLY` mode. In this mode, the engine evaluates policies and logs the decisions, but doesn't actually block anything:

```bash
aws bedrock-agentcore update-gateway \
  --gateway-arn <YOUR_GATEWAY_ARN> \
  --policy-engine-arn <YOUR_POLICY_ENGINE_ARN> \
  --policy-engine-mode LOG_ONLY
```

Run your test script again. All three tools should still work, but check CloudWatch Logs to see the policy decisions. You'll see `ALLOW` for `add_numbers` and `greet_user`, and `DENY` for `multiply_numbers`.

### Step 10: Switch to ENFORCE mode

Once you're satisfied with the policy decisions in the logs:

```bash
aws bedrock-agentcore update-gateway \
  --gateway-arn <YOUR_GATEWAY_ARN> \
  --policy-engine-arn <YOUR_POLICY_ENGINE_ARN> \
  --policy-engine-mode ENFORCE
```

Now run the test script again. `add_numbers` and `greet_user` should still work, but `multiply_numbers` will return an authorization error.

That's the workflow: write a policy (or generate one from plain English), validate in LOG_ONLY mode, then flip to ENFORCE when you're confident.

## What you learned

- MCP is a standard protocol for agent-tool communication over HTTP
- AgentCore supports MCP natively with `serverProtocol: "MCP"`
- Cognito provides JWT tokens; AgentCore validates them at the gateway
- Pulumi secrets encrypt sensitive config values like passwords
- Cedar policies use a default-deny model: everything is blocked unless explicitly permitted
- The Policy Engine workflow is: create engine, add policies, test in LOG_ONLY, switch to ENFORCE

Next up: [Module 3 — Multi-agent orchestration](03-multi-agent-orchestration.md)
