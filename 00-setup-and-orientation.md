# Module 0: Setup and orientation

**Duration:** ~15 minutes

## What you'll learn

- What Amazon Bedrock AgentCore, Strands SDK, and Pulumi ESC are
- How they connect to each other
- How to configure AWS credentials through OIDC so you never touch a static access key

## The big picture

Before we write any code, here's how the pieces fit together.

**Amazon Bedrock AgentCore** is a managed runtime for AI agents. You give it a container image with your agent code, and it handles hosting, scaling, and invocation. Think of it as "Lambda for agents": you don't manage servers, you just deploy a container and call it.

**Strands SDK** is a Python framework for writing agents. You define a system prompt, attach tools, and Strands handles the conversation loop with the LLM. It has a built-in `BedrockAgentCoreApp` class that wraps your agent as an HTTP service compatible with AgentCore Runtime.

**Pulumi** is the infrastructure-as-code tool we use to define and deploy everything: S3 buckets, ECR repositories, IAM roles, CodeBuild projects, and the AgentCore runtimes themselves. All in TypeScript.

**Pulumi ESC** (Environments, Secrets, and Configuration) is Pulumi's secrets management layer. Instead of storing AWS access keys in your shell or a `.env` file, ESC uses OIDC federation to get short-lived credentials from AWS on demand. The credentials rotate automatically and never hit disk.

Here's the flow:

```
You write agent code (Python/Strands)
    ↓
Pulumi deploys infrastructure (TypeScript)
    ↓
ESC provides AWS credentials (OIDC)
    ↓
CodeBuild packages your agent into a Docker image
    ↓
AgentCore Runtime runs your agent
```

## Step 1: Log into Pulumi Cloud

If you haven't already, create a free Pulumi account and log in:

```bash
pulumi login
```

This opens a browser window. Sign in (or create an account), then return to the terminal.

Verify it worked:

```bash
pulumi whoami
```

You should see your username.

## Step 2: Set up the ESC environment for AWS OIDC

Pulumi ESC replaces static AWS credentials with short-lived OIDC tokens. Here's how that works: Pulumi Cloud acts as an identity provider that AWS trusts. When you run `pulumi up`, ESC requests temporary credentials from AWS using your Pulumi identity. The credentials last one hour and are never stored anywhere.

Your instructor has already set up the OIDC trust relationship in the workshop AWS account. You just need to create a local reference to the ESC environment.

Check that the environment exists:

```bash
pulumi env open pulumi-idp/auth
```

You should see temporary AWS credentials printed to the terminal. These will be injected automatically into every `pulumi up` command.

If you see an error, ask your instructor. The ESC environment may need to be shared with your Pulumi organization.

## Step 3: Verify your setup

Let's make sure everything works end-to-end. Create a throwaway Pulumi project:

```bash
mkdir /tmp/verify-setup && cd /tmp/verify-setup
pulumi new aws-typescript --name verify-setup --yes
```

Open `Pulumi.dev.yaml` and add the ESC environment reference:

```yaml
environment:
  - pulumi-idp/auth
```

Run a preview:

```bash
pulumi preview
```

If this succeeds, your AWS credentials are working through OIDC and you're ready for Module 1. Destroy the test project:

```bash
pulumi destroy --yes
cd -
rm -rf /tmp/verify-setup
```

## Step 4: Pick your unique identifier

Every module creates AWS resources (IAM roles, ECR repos, AgentCore runtimes) that need unique names within the AWS account. If multiple participants share the same account and use the same default names, you'll get conflicts.

Pick a short identifier now — your initials, a nickname, anything 2-5 characters. You'll use it in every module as your `stackName` prefix.

For example, if your identifier is `ed`:

```
Module 1: agentcore-basic-ed
Module 2: agentcore-mcp-ed
Module 3: agentcore-multi-ed
Module 4: agentcore-weather-ed
```

You set this at the start of each module with:

```bash
pulumi config set stackName agentcore-basic-ed
```

Keep this identifier consistent across all modules. Write it down.

## Step 5: Familiarize yourself with the workshop structure

Each module has a markdown file with instructions (what you're reading now) and a solution folder (e.g., `01-solution/typescript/`) with the complete working code if you get stuck.

The modules build on each other. By Module 4, you'll have deployed a multi-tool agent that browses websites, runs Python code, and remembers user preferences.

## What you learned

- AgentCore is a managed container runtime for AI agents
- Strands SDK is the Python framework for writing agent logic
- Pulumi ESC provides AWS credentials through OIDC federation — no static keys
- Your local setup can authenticate with AWS and run `pulumi preview`

Next up: [Module 1 — Your first agent on AgentCore](01-your-first-agent.md)
