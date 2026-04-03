---
---
# Module 1: Your first agent on AgentCore

**Duration:** ~30 minutes

## What you'll learn

- How the AgentCore deployment pipeline works (source code to running agent)
- How to write a Strands agent in Python
- How to define the infrastructure in Pulumi TypeScript
- How to deploy, invoke, and tear down an agent

## How agents get deployed on AgentCore

Before you start coding, it helps to understand what actually happens when you run `pulumi up` for an agent. There are several moving parts, and they run in a specific order.

Here's the pipeline:

```text
Python agent code
    ↓  (zipped and uploaded)
S3 bucket
    ↓  (CodeBuild reads source)
CodeBuild (ARM64 Docker build)
    ↓  (pushes image)
ECR repository
    ↓  (AgentCore pulls image)
AgentCore Runtime (your agent is live)
```

Why not just build the Docker image locally and push it? Two reasons. First, AgentCore runs ARM64 containers, and building ARM64 images on an x86 laptop is slow and finicky. CodeBuild runs on native ARM64 hardware, so the build is fast and reliable. Second, CodeBuild runs inside your AWS account with the right permissions — no need to configure Docker credentials locally.

The Lambda function in the middle is a glue piece. Pulumi triggers it during deployment, and it starts the CodeBuild job and polls until the build finishes. This way Pulumi waits for the image to be ready before creating the AgentCore Runtime.

The agent execution IAM role is the identity your agent runs under. It has a trust relationship with `bedrock-agentcore.amazonaws.com`, which means only AgentCore can assume it. The role gets permissions for ECR (pulling images), CloudWatch (logging), X-Ray (tracing), and Bedrock (calling LLMs).

## Step 1: Create a new Pulumi project

<div class="lang-tabs" markdown="1">

<div class="lang-tab" data-lang="typescript" markdown="1">

```bash
mkdir 01-my-first-agent && cd 01-my-first-agent
pulumi new aws-typescript --name my-first-agent --yes
```

</div>

<div class="lang-tab" data-lang="python" markdown="1">

```bash
mkdir 01-my-first-agent && cd 01-my-first-agent
pulumi new aws-python --name my-first-agent --yes
```

</div>

</div>

Add the ESC environment for AWS credentials. Open `Pulumi.dev.yaml` and set:

```yaml
environment:
  - pulumi-idp/auth
```

Install the AWS provider:

<div class="lang-tabs" markdown="1">

<div class="lang-tab" data-lang="typescript" markdown="1">

```bash
npm install @pulumi/aws@7.23.0
```

</div>

<div class="lang-tab" data-lang="python" markdown="1">

Dependencies are managed in `pyproject.toml` — no install step needed. Pulumi with `uv` handles this automatically.

</div>

</div>

Set your unique stack name (replace `<id>` with the identifier you picked in Module 0):

```bash
pulumi config set stackName agentcore-basic-<id>
```

## Step 2: Write the agent code

Create the agent source directory:

```bash
mkdir -p agent-code
```

Create `agent-code/basic_agent.py`:

```python
from strands import Agent
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()


def create_basic_agent() -> Agent:
    """Create a basic agent with simple functionality"""
    system_prompt = (
        """You are a helpful assistant. Answer questions clearly and concisely."""
    )

    return Agent(system_prompt=system_prompt, name="BasicAgent")


@app.entrypoint
async def invoke(payload=None):
    """Main entrypoint for the agent"""
    try:
        query = (
            payload.get("prompt", "Hello, how are you?")
            if payload
            else "Hello, how are you?"
        )

        agent = create_basic_agent()
        response = agent(query)

        return {"status": "success", "response": response.message["content"][0]["text"]}

    except Exception as e:
        return {"status": "error", "error": str(e)}


if __name__ == "__main__":
    app.run()
```

A few things to notice here. `BedrockAgentCoreApp` wraps your agent as an HTTP service that AgentCore knows how to call. The `@app.entrypoint` decorator marks the function that gets called when someone invokes your agent. The payload comes in as a dict with a `"prompt"` key.

Create `agent-code/requirements.txt`:

```text
strands-agents
boto3
bedrock-agentcore
```

Create `agent-code/Dockerfile`:

```dockerfile
FROM public.ecr.aws/docker/library/python:3.11-slim

WORKDIR /app

COPY requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt && \
    pip install --no-cache-dir aws-opentelemetry-distro==0.10.1

# Create non-root user
RUN useradd -m -u 1000 bedrock_agentcore
USER bedrock_agentcore

EXPOSE 8080
EXPOSE 8000

COPY . .

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/ping || exit 1

CMD ["opentelemetry-instrument", "python", "-m", "basic_agent"]
```

The container runs as a non-root user (`bedrock_agentcore`) because AgentCore requires it. Port 8080 is the main agent endpoint and 8000 is for health checks. The OpenTelemetry instrumentation gives you free distributed tracing.

## Step 3: Create the build trigger Lambda

This Lambda function starts a CodeBuild job and polls until it completes. Pulumi calls it during deployment.

```bash
mkdir -p lambda/build-trigger
```

Create `lambda/build-trigger/index.py`:

```python
import json
import logging
import time

import boto3


LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)


def handler(event, _context):
    LOGGER.info("Received event: %s", json.dumps(event))

    project_name = event["projectName"]
    region = event.get("region")
    poll_interval_seconds = int(event.get("pollIntervalSeconds", 15))

    codebuild = boto3.client("codebuild", region_name=region)
    response = codebuild.start_build(projectName=project_name)
    build_id = response["build"]["id"]
    LOGGER.info("Started build %s for project %s", build_id, project_name)

    while True:
        build_response = codebuild.batch_get_builds(ids=[build_id])
        build = build_response["builds"][0]
        status = build["buildStatus"]

        if status == "SUCCEEDED":
            LOGGER.info("Build %s succeeded", build_id)
            return {
                "buildId": build_id,
                "status": status,
                "imageDigest": build.get("resolvedSourceVersion"),
            }

        if status in {"FAILED", "FAULT", "STOPPED", "TIMED_OUT"}:
            LOGGER.error("Build %s failed with status %s", build_id, status)
            raise RuntimeError(f"CodeBuild {build_id} failed with status {status}")

        LOGGER.info("Build %s status: %s", build_id, status)
        time.sleep(poll_interval_seconds)
```

## Step 4: Create the buildspec

Create `buildspec.yml` in the project root:

```yaml
version: 0.2

phases:
  pre_build:
    commands:
      - echo Source code already extracted by CodeBuild
      - cd $CODEBUILD_SRC_DIR
      - echo Logging in to Amazon ECR
      - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com

  build:
    commands:
      - echo Build started on `date`
      - echo Building the Docker image for the basic agent ARM64 image
      - docker build -t $IMAGE_REPO_NAME:$IMAGE_TAG .
      - docker tag $IMAGE_REPO_NAME:$IMAGE_TAG $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG

  post_build:
    commands:
      - echo Build completed on `date`
      - echo Pushing the Docker image
      - docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG
      - echo ARM64 Docker image pushed successfully
```

## Step 5: Write the Pulumi infrastructure

Now the big part. Open `index.ts` and replace its contents with the infrastructure definition.

The code is long, so we'll go through it section by section. You can also look at the complete file at `01-solution/typescript/index.ts` (or `01-solution/python/__main__.py` for the Python version).

First, the configuration and data sources:

<div class="lang-tabs" markdown="1">

<div class="lang-tab" data-lang="typescript" markdown="1">

```typescript
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

const config = new pulumi.Config();
const agentName = config.get("agentName") || "BasicAgent";
const networkMode = config.get("networkMode") || "PUBLIC";
const imageTag = config.get("imageTag") || "latest";
const stackName = config.get("stackName") || "agentcore-basic";
const description =
  config.get("description") ||
  "Basic AgentCore runtime with a simple Strands agent";
const environmentVariables =
  config.getObject<Record<string, string>>("environmentVariables") || {};
const ecrRepositoryName = config.get("ecrRepositoryName") || "basic-agent";

const awsConfig = new pulumi.Config("aws");
const awsRegion = awsConfig.require("region");

const currentIdentity = aws.getCallerIdentityOutput({});
const currentRegion = aws.getRegionOutput({});
```

</div>

<div class="lang-tab" data-lang="python" markdown="1">

```python
import pulumi
import pulumi_aws as aws
import hashlib
import json
import os

config = pulumi.Config()
agent_name = config.get("agentName") or "BasicAgent"
network_mode = config.get("networkMode") or "PUBLIC"
image_tag = config.get("imageTag") or "latest"
stack_name = config.get("stackName") or "agentcore-basic"
description = (
    config.get("description")
    or "Basic AgentCore runtime with a simple Strands agent"
)
environment_variables = config.get_object("environmentVariables") or {}
ecr_repository_name = config.get("ecrRepositoryName") or "basic-agent"

aws_config = pulumi.Config("aws")
aws_region = aws_config.require("region")

current_identity = aws.get_caller_identity_output()
current_region = aws.get_region_output()
```

</div>

</div>

Next, the S3 bucket for source code. The agent code gets zipped and uploaded here so CodeBuild can read it:

<div class="lang-tabs" markdown="1">

<div class="lang-tab" data-lang="typescript" markdown="1">

```typescript
const agentSourceBucket = new aws.s3.Bucket("agent_source", {
  bucketPrefix: `${stackName}-source-`,
  forceDestroy: true,
  tags: {
    Name: `${stackName}-agent-source`,
    Purpose: "Store agent source code for CodeBuild",
  },
});

new aws.s3.BucketPublicAccessBlock("agent_source", {
  bucket: agentSourceBucket.id,
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
});

new aws.s3.BucketVersioning("agent_source", {
  bucket: agentSourceBucket.id,
  versioningConfiguration: { status: "Enabled" },
});

const agentSourceObject = new aws.s3.BucketObjectv2("agent_source", {
  bucket: agentSourceBucket.id,
  key: "agent-code.zip",
  source: new pulumi.asset.FileArchive(path.resolve(__dirname, "agent-code")),
  tags: { Name: "agent-source-code" },
});
```

</div>

<div class="lang-tab" data-lang="python" markdown="1">

```python
agent_source_bucket = aws.s3.Bucket(
    "agent_source",
    bucket_prefix=f"{stack_name}-source-",
    force_destroy=True,
    tags={
        "Name": f"{stack_name}-agent-source",
        "Purpose": "Store agent source code for CodeBuild",
    },
)

aws.s3.BucketPublicAccessBlock(
    "agent_source",
    bucket=agent_source_bucket.id,
    block_public_acls=True,
    block_public_policy=True,
    ignore_public_acls=True,
    restrict_public_buckets=True,
)

aws.s3.BucketVersioning(
    "agent_source",
    bucket=agent_source_bucket.id,
    versioning_configuration={"status": "Enabled"},
)

agent_source_object = aws.s3.BucketObjectv2(
    "agent_source",
    bucket=agent_source_bucket.id,
    key="agent-code.zip",
    source=pulumi.FileArchive(os.path.join(os.path.dirname(__file__), "agent-code")),
    tags={"Name": "agent-source-code"},
)
```

</div>

</div>

The ECR repository stores the Docker image:

<div class="lang-tabs" markdown="1">

<div class="lang-tab" data-lang="typescript" markdown="1">

```typescript
const agentEcr = new aws.ecr.Repository("agent_ecr", {
  name: `${stackName}-${ecrRepositoryName}`,
  imageTagMutability: "MUTABLE",
  imageScanningConfiguration: { scanOnPush: true },
  forceDelete: true,
  tags: { Name: `${stackName}-ecr-repository`, Module: "ECR" },
});
```

</div>

<div class="lang-tab" data-lang="python" markdown="1">

```python
agent_ecr = aws.ecr.Repository(
    "agent_ecr",
    name=f"{stack_name}-{ecr_repository_name}",
    image_tag_mutability="MUTABLE",
    image_scanning_configuration={"scan_on_push": True},
    force_delete=True,
    tags={"Name": f"{stack_name}-ecr-repository", "Module": "ECR"},
)
```

</div>

</div>

The agent execution role is what your running agent uses to call AWS services. The trust policy only allows AgentCore to assume it:

<div class="lang-tabs" markdown="1">

<div class="lang-tab" data-lang="typescript" markdown="1">

```typescript
const agentExecution = new aws.iam.Role("agent_execution", {
  name: `${stackName}-agent-execution-role`,
  assumeRolePolicy: pulumi.jsonStringify({
    Version: "2012-10-17",
    Statement: [{
      Sid: "AssumeRolePolicy",
      Effect: "Allow",
      Principal: { Service: "bedrock-agentcore.amazonaws.com" },
      Action: "sts:AssumeRole",
      Condition: {
        StringEquals: {
          "aws:SourceAccount": currentIdentity.apply((id) => id.accountId),
        },
        ArnLike: {
          "aws:SourceArn": pulumi.all([currentRegion, currentIdentity]).apply(
            ([region, identity]) =>
              `arn:aws:bedrock-agentcore:${region.region}:${identity.accountId}:*`,
          ),
        },
      },
    }],
  }),
});
```

</div>

<div class="lang-tab" data-lang="python" markdown="1">

```python
agent_execution = aws.iam.Role(
    "agent_execution",
    name=f"{stack_name}-agent-execution-role",
    assume_role_policy=pulumi.Output.json_dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Sid": "AssumeRolePolicy",
            "Effect": "Allow",
            "Principal": {"Service": "bedrock-agentcore.amazonaws.com"},
            "Action": "sts:AssumeRole",
            "Condition": {
                "StringEquals": {
                    "aws:SourceAccount": current_identity.apply(
                        lambda id: id.account_id
                    ),
                },
                "ArnLike": {
                    "aws:SourceArn": pulumi.Output.all(
                        current_region, current_identity
                    ).apply(
                        lambda args: f"arn:aws:bedrock-agentcore:{args[0].name}:{args[1].account_id}:*"
                    ),
                },
            },
        }],
    }),
)
```

</div>

</div>

The role needs policies for ECR, CloudWatch, X-Ray, Bedrock model invocation, and AgentCore workload tokens. See the full `index.ts` in the solution folder for the complete policy statements.

Finally, the AgentCore Runtime itself. This is the actual agent resource:

<div class="lang-tabs" markdown="1">

<div class="lang-tab" data-lang="typescript" markdown="1">

```typescript
const basicAgent = new aws.bedrock.AgentcoreAgentRuntime("basic_agent", {
  agentRuntimeName: `${stackName}_${agentName}`.replace(/-/g, "_"),
  description: description,
  roleArn: agentExecution.arn,
  agentRuntimeArtifact: {
    containerConfiguration: {
      containerUri: pulumi.interpolate`${agentEcr.repositoryUrl}:${imageTag}`,
    },
  },
  networkConfiguration: { networkMode: networkMode },
  environmentVariables: {
    AWS_REGION: awsRegion,
    AWS_DEFAULT_REGION: awsRegion,
    ...environmentVariables,
  },
}, {
  dependsOn: [triggerBuild, agentExecutionRolePolicy, agentExecutionManaged],
});

export const agentRuntimeArn = basicAgent.agentRuntimeArn;
```

</div>

<div class="lang-tab" data-lang="python" markdown="1">

```python
basic_agent = aws.bedrock.AgentcoreAgentRuntime(
    "basic_agent",
    agent_runtime_name=f"{stack_name}_{agent_name}".replace("-", "_"),
    description=description,
    role_arn=agent_execution.arn,
    agent_runtime_artifact={
        "container_configuration": {
            "container_uri": pulumi.Output.concat(
                agent_ecr.repository_url, ":", image_tag
            ),
        }
    },
    network_configuration={"network_mode": network_mode},
    environment_variables={
        "AWS_REGION": aws_region,
        "AWS_DEFAULT_REGION": aws_region,
        **environment_variables,
    },
    opts=pulumi.ResourceOptions(
        depends_on=[trigger_build, agent_execution_role_policy, agent_execution_managed]
    ),
)

pulumi.export("agentRuntimeArn", basic_agent.agent_runtime_arn)
```

</div>

</div>

The `dependsOn` is important. It makes sure the Docker image is built and pushed to ECR before Pulumi tries to create the runtime.

## Complete solution files

### Agent implementation

<div class="lang-tabs" markdown="1">

<div class="lang-tab" data-lang="typescript" markdown="1">

{% highlight python %}
{% include_relative 01-solution/typescript/agent-code/basic_agent.py %}
{% endhighlight %}

</div>

<div class="lang-tab" data-lang="python" markdown="1">

{% highlight python %}
{% include_relative 01-solution/python/agent-code/basic_agent.py %}
{% endhighlight %}

</div>

</div>

### Infrastructure

<div class="lang-tabs" markdown="1">

<div class="lang-tab" data-lang="typescript" markdown="1">

{% highlight typescript %}
{% include_relative 01-solution/typescript/index.ts %}
{% endhighlight %}

</div>

<div class="lang-tab" data-lang="python" markdown="1">

{% highlight python %}
{% include_relative 01-solution/python/__main__.py %}
{% endhighlight %}

</div>

</div>

## Step 6: Deploy

```bash
pulumi up
```

This will take 5-10 minutes on the first run. Most of that time is CodeBuild building and pushing the Docker image. You'll see the resources being created in order: S3 bucket, ECR repo, IAM roles, CodeBuild project, Lambda trigger, and finally the AgentCore Runtime.

Watch the Pulumi output for the `agentRuntimeArn` at the end.

## Step 7: Invoke your agent

Once deployed, test it with the provided test script. First, grab the ARN from the stack output:

```bash
export AGENT_ARN=$(pulumi stack output agentRuntimeArn)
```

Create `test_basic_agent.py` (or copy from the solution folder):

```python
#!/usr/bin/env python3
import boto3
import json
import sys

def main():
    if len(sys.argv) < 2:
        print("Usage: python test_basic_agent.py <agent_runtime_arn>")
        sys.exit(1)

    agent_arn = sys.argv[1]
    region = agent_arn.split(":")[3]

    client = boto3.client("bedrock-agentcore", region_name=region)

    print("Invoking agent...")
    response = client.invoke_agent_runtime(
        agentRuntimeArn=agent_arn,
        qualifier="DEFAULT",
        payload=json.dumps({"prompt": "What is Amazon Bedrock AgentCore?"}),
    )

    content = []
    for chunk in response.get("response", []):
        content.append(chunk.decode("utf-8"))

    result = json.loads("".join(content))
    print(f"\nStatus: {result.get('status')}")
    print(f"Response: {result.get('response', result.get('error'))}")

if __name__ == "__main__":
    main()
```

Run it:

```bash
python test_basic_agent.py $AGENT_ARN
```

You should see a response from your agent.

## Try it yourself

Your agent is running. Here are some things worth experimenting with before you move on.

**Change the system prompt.** Open `agent-code/basic_agent.py` and rewrite the `system_prompt` string. Make it a pirate, a haiku poet, or a sarcastic code reviewer. Then redeploy with `pulumi up` — CodeBuild will rebuild the image and AgentCore will pick it up. Try a few prompts against the new personality.

**Send your own prompts.** You don't need the test script. Here's a one-liner you can modify:

```bash
python3 -c "
import boto3, json
client = boto3.client('bedrock-agentcore', region_name='us-east-1')
r = client.invoke_agent_runtime(
    agentRuntimeArn='$(pulumi stack output agentRuntimeArn)',
    qualifier='DEFAULT',
    payload=json.dumps({'prompt': 'Write a limerick about infrastructure as code'}),
)
print(json.loads(r['response'].read().decode())['response'])
"
```

**Pass environment variables.** The `index.ts` already supports custom env vars via config. Try:

```bash
pulumi config set --path 'environmentVariables.AGENT_MODE' 'verbose'
```

Then read `os.getenv("AGENT_MODE")` in your Python code and change the agent's behavior based on it. Redeploy with `pulumi up`.

## Step 8: Clean up (optional)

If you want to tear down the resources before moving on:

```bash
pulumi destroy --yes
```

You can also leave them running. Module 2 is a separate stack.

## What you learned

- AgentCore deploys agents as containerized services running on ARM64
- The deployment pipeline goes: S3 (source) → CodeBuild (Docker build) → ECR (image registry) → AgentCore Runtime
- A Lambda function bridges Pulumi and CodeBuild, triggering builds and waiting for completion
- The agent execution role uses a trust relationship with `bedrock-agentcore.amazonaws.com`
- Strands' `BedrockAgentCoreApp` wraps your Python agent as an HTTP-callable service
- `pulumi up` orchestrates the entire pipeline in the right order using `dependsOn`

Next up: [Module 2 — Hosting an MCP server with JWT auth](02-mcp-server-jwt-auth.md)
