# Claude Code guidance

## Project overview

This is a hands-on workshop teaching participants to deploy AI agents on AWS using Pulumi and Amazon Bedrock AgentCore. It has 6 modules (0-5) progressing from setup through a full-stack weather agent.

## Project structure

- Root markdown files (`00-*.md` through `05-*.md`) are the workshop instructions
- `XX-solution/typescript/` directories contain the complete Pulumi TypeScript solutions
- Each solution has an `index.ts` (Pulumi program), agent code (Python), Dockerfiles, buildspecs, lambda functions, and test scripts
- `esc/` contains Pulumi ESC environment templates for AWS OIDC auth
- `.devcontainer/` has the GitHub Codespaces configuration

## Technology stack

- **IaC:** Pulumi with TypeScript (`@pulumi/aws` provider)
- **Agent framework:** Strands SDK (Python)
- **Runtime:** Amazon Bedrock AgentCore
- **Auth:** Amazon Cognito (JWT), Pulumi ESC (OIDC)
- **Build:** AWS CodeBuild (ARM64 Docker images)
- **Container registry:** Amazon ECR
- **Policy:** Cedar-based AgentCore Policy Engine
- **Observability:** CloudWatch Logs, X-Ray

## Key commands

```bash
# Deploy a module solution
cd XX-solution/typescript
npm install
pulumi up

# Test an agent
python test_basic_agent.py <agent-runtime-arn>

# Destroy resources
pulumi destroy --yes
```

## Architecture pattern

Every agent follows the same deployment pipeline:
1. Python agent code → zipped to S3
2. CodeBuild builds ARM64 Docker image → pushes to ECR
3. Lambda triggers CodeBuild and polls for completion
4. AgentCore Runtime created with container URI from ECR

## Writing conventions

- Module markdown should be direct, practical, and human-sounding
- No AI slop words (pivotal, crucial, landscape, delve, foster, showcase, underscore)
- Sentence case for headings
- Explain concepts before showing code
- Every module ends with verification steps
