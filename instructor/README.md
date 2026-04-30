# Instructor credential sharing site

A static website deployed via CloudFront that displays workshop credentials and config values with click-to-copy. No more mistyped tokens from PowerPoint slides.

## What it does

1. This stack creates an IAM user for the workshop participants with the needed permissions to deploy the workshop infrastucture.
2. It publishes the AWS user credentials to a cloudfront distribution that participants can access to set up their environment to use the provided AWS account.
3. The page is uploaded to S3 and served via CloudFront with HTTPS
4. Participants open the URL and click to copy any value they need
3. As the instructor you just need an ESC environment or local SSO creds that allow enables the stack to create an IAM user and CloudFront related resources declared in this project. 

## Setup

### 1. Set up AWS credentials for the stack

The credentials need to be able to create IAM user and policies and the various cloudfront related infrastructure the stack deploys.

### 2. Deploy

```bash
cd instructor
npm install
pulumi up
```

The output includes the CloudFront URL. Share this URL with participants.

### 3. Update values

To change values mid-workshop add or update the `keyVersion` stack config item to `2` or greater:

```bash
# Update the ESC environment
pulumi config set keyVersion 2

# Redeploy (takes ~30 seconds)
pulumi up --yes
```

The HTML regenerates with the new values. CloudFront cache TTL is 5 minutes, so changes propagate quickly. To force immediate propagation:

```bash
aws cloudfront create-invalidation --distribution-id $(pulumi stack output distributionId) --paths "/*"
```

### 4. Tear down

```bash
pulumi destroy --yes
```

## Architecture

```
Pulumi ESC (workshop-values)
    |  config values
Pulumi program (index.ts)
    |  generates HTML
S3 bucket (private)
    |  OAC
CloudFront distribution (HTTPS)
    |
Participants browser
```

## Adding custom values

Edit the ESC environment to add any key-value pair. The site renders all pairs from `instructor:values` automatically. Sensitive values (tokens, passwords) are displayed in monospace with a copy button, so participants never need to type them manually.
