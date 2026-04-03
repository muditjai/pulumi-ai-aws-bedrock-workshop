import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

// ============================================================================
// Configuration
// ============================================================================

const config = new pulumi.Config();
const workshopTitle = config.get("workshopTitle") || "Workshop Credentials";
const values = config.requireObject<Record<string, string>>("values");

// ============================================================================
// Generate HTML
// ============================================================================

function generateHtml(
  title: string,
  kvPairs: Record<string, string>,
): string {
  const cards = Object.entries(kvPairs)
    .map(
      ([key, value], i) => `
      <div class="card" data-value="${value.replace(/"/g, "&quot;")}" onclick="copyCard(this)" style="animation-delay: ${0.1 + i * 0.08}s">
        <div class="card-inner">
          <div class="card-left">
            <span class="card-key">${key}</span>
            <code class="card-val">${value}</code>
          </div>
          <div class="card-action">
            <span class="action-label">COPY</span>
            <span class="action-done">COPIED</span>
          </div>
        </div>
        <div class="card-flash"></div>
      </div>`,
    )
    .join("\n");

  const count = Object.keys(kvPairs).length;
  const now = new Date().toISOString().split("T")[0];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #08080c;
      --surface: rgba(255,255,255,0.03);
      --surface-hover: rgba(255,255,255,0.06);
      --border: rgba(255,255,255,0.07);
      --amber: #f0a830;
      --amber-dim: #c78520;
      --amber-glow: rgba(240,168,48,0.08);
      --amber-flash: rgba(240,168,48,0.15);
      --green: #34d399;
      --text: #d4d4d8;
      --text-dim: #63636e;
      --font-display: 'Outfit', system-ui, sans-serif;
      --font-mono: 'IBM Plex Mono', 'SF Mono', monospace;
    }

    html { font-size: 16px; }

    body {
      font-family: var(--font-display);
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      overflow-x: hidden;
      -webkit-font-smoothing: antialiased;
    }

    /* Scanline overlay */
    body::after {
      content: '';
      position: fixed;
      inset: 0;
      background: repeating-linear-gradient(
        0deg,
        transparent,
        transparent 2px,
        rgba(0,0,0,0.08) 2px,
        rgba(0,0,0,0.08) 4px
      );
      pointer-events: none;
      z-index: 1000;
    }

    /* Ambient glow */
    .glow {
      position: fixed;
      width: 600px;
      height: 600px;
      border-radius: 50%;
      background: radial-gradient(circle, var(--amber-glow) 0%, transparent 70%);
      top: -200px;
      left: 50%;
      transform: translateX(-50%);
      pointer-events: none;
      z-index: 0;
    }

    .container {
      position: relative;
      z-index: 1;
      max-width: 680px;
      margin: 0 auto;
      padding: 72px 24px 80px;
    }

    @media (max-width: 640px) {
      .container { padding: 40px 16px 48px; }
    }

    /* Header */
    .header { margin-bottom: 48px; }

    .header-meta {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
      font-family: var(--font-mono);
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--text-dim);
    }

    .header-meta .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--green);
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    h1 {
      font-family: var(--font-display);
      font-size: clamp(1.6rem, 4.5vw, 2.2rem);
      font-weight: 700;
      letter-spacing: -0.03em;
      line-height: 1.15;
      color: #fff;
      margin-bottom: 14px;
    }

    h1 .highlight {
      color: var(--amber);
    }

    .subtitle {
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-dim);
      line-height: 1.6;
    }

    .subtitle kbd {
      display: inline-block;
      font-family: var(--font-mono);
      font-size: 11px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 4px;
      padding: 1px 6px;
      vertical-align: 1px;
    }

    /* Divider */
    .divider {
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--border), transparent);
      margin: 32px 0;
    }

    /* Cards */
    .cards {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .card {
      position: relative;
      overflow: hidden;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      cursor: pointer;
      user-select: none;
      transition: border-color 0.2s, background 0.2s, transform 0.15s;
      animation: slideIn 0.4s ease-out both;
    }

    @keyframes slideIn {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .card:hover {
      border-color: rgba(240,168,48,0.25);
      background: var(--surface-hover);
    }

    .card:active {
      transform: scale(0.995);
    }

    .card-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 18px 20px;
      gap: 16px;
      position: relative;
      z-index: 2;
    }

    .card-left {
      flex: 1;
      min-width: 0;
    }

    .card-key {
      display: block;
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--amber-dim);
      margin-bottom: 6px;
    }

    .card-val {
      display: block;
      font-family: var(--font-mono);
      font-size: 13.5px;
      font-weight: 400;
      color: var(--text);
      word-break: break-all;
      line-height: 1.5;
      background: none;
    }

    .card-action {
      flex-shrink: 0;
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--text-dim);
      transition: color 0.15s;
    }

    .card:hover .card-action { color: var(--amber); }

    .card-action .action-done {
      display: none;
      color: var(--green);
    }

    .card.copied .action-label { display: none; }
    .card.copied .action-done { display: inline; }

    /* Flash effect on copy */
    .card-flash {
      position: absolute;
      inset: 0;
      background: var(--amber-flash);
      opacity: 0;
      z-index: 1;
      pointer-events: none;
      transition: opacity 0.4s;
    }

    .card.flash .card-flash {
      opacity: 1;
      transition: opacity 0s;
    }

    /* Toast */
    .toast {
      position: fixed;
      bottom: 28px;
      left: 50%;
      transform: translateX(-50%) translateY(16px);
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 500;
      letter-spacing: 0.04em;
      color: var(--green);
      background: rgba(8,8,12,0.95);
      border: 1px solid rgba(52,211,153,0.2);
      border-radius: 6px;
      padding: 10px 20px;
      opacity: 0;
      transition: opacity 0.25s, transform 0.25s;
      pointer-events: none;
      z-index: 999;
      backdrop-filter: blur(12px);
    }

    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }

    /* Footer */
    .footer {
      margin-top: 48px;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-dim);
      text-align: center;
      letter-spacing: 0.02em;
    }

    .footer a {
      color: var(--amber-dim);
      text-decoration: none;
    }
    .footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="glow"></div>

  <div class="container">
    <header class="header">
      <div class="header-meta">
        <span class="dot"></span>
        <span>live &middot; ${count} values &middot; ${now}</span>
      </div>
      <h1>${title.replace("Pulumi", '<span class="highlight">Pulumi</span>').replace("AgentCore", '<span class="highlight">AgentCore</span>')}</h1>
      <p class="subtitle">Click any row to copy its value. Works on mobile too.</p>
    </header>

    <div class="divider"></div>

    <div class="cards">
      ${cards}
    </div>

    <div class="divider"></div>

    <footer class="footer">
      Served from <a href="https://www.pulumi.com/product/esc/" target="_blank">Pulumi ESC</a> &middot; Deployed with <a href="https://www.pulumi.com" target="_blank">Pulumi</a>
    </footer>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    function copyCard(card) {
      const value = card.dataset.value;
      navigator.clipboard.writeText(value).then(() => {
        // Flash
        card.classList.add('flash', 'copied');
        requestAnimationFrame(() => {
          requestAnimationFrame(() => card.classList.remove('flash'));
        });

        // Toast
        const label = card.querySelector('.card-key').textContent;
        const toast = document.getElementById('toast');
        toast.textContent = label + ' copied to clipboard';
        toast.classList.add('show');

        setTimeout(() => {
          card.classList.remove('copied');
          toast.classList.remove('show');
        }, 2000);
      });
    }
  </script>
</body>
</html>`;
}

// ============================================================================
// S3 Bucket (private, CloudFront origin)
// ============================================================================

const siteBucket = new aws.s3.Bucket("site", {
  bucketPrefix: "workshop-instructor-",
  forceDestroy: true,
  tags: { Name: "workshop-instructor-site", Purpose: "Instructor credential sharing" },
});

new aws.s3.BucketPublicAccessBlock("site", {
  bucket: siteBucket.id,
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
});

// ============================================================================
// Generate and upload HTML
// ============================================================================

const htmlContent = generateHtml(workshopTitle, values);

const indexHtml = new aws.s3.BucketObjectv2("index", {
  bucket: siteBucket.id,
  key: "index.html",
  content: htmlContent,
  contentType: "text/html",
  tags: { Name: "instructor-index-html" },
});

// ============================================================================
// CloudFront Origin Access Control
// ============================================================================

const oac = new aws.cloudfront.OriginAccessControl("site", {
  name: "workshop-instructor-oac",
  description: "OAC for instructor credential site",
  originAccessControlOriginType: "s3",
  signingBehavior: "always",
  signingProtocol: "sigv4",
});

// ============================================================================
// CloudFront Distribution
// ============================================================================

// Use AWS managed CachingOptimized policy instead of deprecated forwardedValues
const cachingOptimized = aws.cloudfront.getCachePolicyOutput({
  name: "Managed-CachingOptimized",
});

const distribution = new aws.cloudfront.Distribution("site", {
  enabled: true,
  defaultRootObject: "index.html",
  comment: "Workshop instructor credential sharing site",
  origins: [
    {
      domainName: siteBucket.bucketRegionalDomainName,
      originId: "s3-origin",
      originAccessControlId: oac.id,
    },
  ],
  defaultCacheBehavior: {
    targetOriginId: "s3-origin",
    viewerProtocolPolicy: "redirect-to-https",
    allowedMethods: ["GET", "HEAD"],
    cachedMethods: ["GET", "HEAD"],
    cachePolicyId: cachingOptimized.apply((p) => p.id!),
    compress: true,
  },
  restrictions: {
    geoRestriction: { restrictionType: "none" },
  },
  viewerCertificate: {
    cloudfrontDefaultCertificate: true,
  },
  tags: { Name: "workshop-instructor-distribution" },
});

// ============================================================================
// S3 Bucket Policy (allow CloudFront via OAC)
// ============================================================================

new aws.s3.BucketPolicy("site", {
  bucket: siteBucket.id,
  policy: pulumi
    .all([siteBucket.arn, distribution.arn])
    .apply(([bucketArn, distArn]) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowCloudFrontOAC",
            Effect: "Allow",
            Principal: { Service: "cloudfront.amazonaws.com" },
            Action: "s3:GetObject",
            Resource: `${bucketArn}/*`,
            Condition: {
              StringEquals: { "AWS:SourceArn": distArn },
            },
          },
        ],
      }),
    ),
});

// ============================================================================
// Outputs
// ============================================================================

export const siteUrl = pulumi.interpolate`https://${distribution.domainName}`;
export const distributionId = distribution.id;
export const bucketName = siteBucket.id;
