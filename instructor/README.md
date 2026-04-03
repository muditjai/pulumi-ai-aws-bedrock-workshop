# Instructor credential sharing site

A static website deployed via CloudFront that displays workshop credentials and config values with click-to-copy. No more mistyped tokens from PowerPoint slides.

## How it works

1. Workshop values (tokens, regions, passwords) are stored in a Pulumi ESC environment
2. The Pulumi program reads the values and generates an HTML page
3. The page is uploaded to S3 and served via CloudFront with HTTPS
4. Participants open the URL and click to copy any value they need

## Setup

### 1. Configure the ESC environment

The workshop values live in the `workshop-values` ESC environment. Update them:

```bash
pulumi env set ediri/workshop-values 'pulumiConfig.instructor:values.Pulumi Access Token' '"your-real-token"' --plaintext
pulumi env set ediri/workshop-values 'pulumiConfig.instructor:values.AWS Region' '"us-east-1"' --plaintext
```

Add or remove keys as needed:

```bash
# Add a new value
pulumi env set ediri/workshop-values 'pulumiConfig.instructor:values.Slack Channel' '"#workshop-help"' --plaintext

# Check current values
pulumi env open ediri/workshop-values
```

### 2. Deploy

```bash
cd instructor
npm install
pulumi up
```

The output includes the CloudFront URL. Share this URL with participants.

### 3. Update values

To change values mid-workshop:

```bash
# Update the ESC environment
pulumi env set ediri/workshop-values 'pulumiConfig.instructor:values.Pulumi Access Token' '"new-token"' --plaintext

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
