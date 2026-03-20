# 🔖 MindMark

**AI-powered resource manager with semantic natural language retrieval**

MindMark is a Chrome extension that lets you save web pages and resources and find them later using
natural language — no folders, no tags, no manual organization. You just describe what
you're looking for and the AI finds it.

**Why MindMark:** Most people save dozens of resources/bookmarks and never find them again.
Existing tools require manual tagging, folder hierarchies, or exact title recall.
MindMark acts as a virtual extension to your knowledge base, allowing you to track resources you already trust!
Maintian your library of resources and query it the way you actually think.

---

## Demo

| Save Tab | Bookmarks Tab |
|---|---|
| Save the current page with an editable title and optional note | View, browse, and delete your saved bookmarks |

---

## How It Works
```
Chrome Extension (Manifest V3)
          ↓  HTTPS POST
AWS API Gateway (HTTP API v2)
          ↓  triggers
AWS Lambda — Node.js 20 (serverless)
          ↓                    ↓
    AWS DynamoDB          AWS Bedrock
  (bookmark storage)   (Claude 3.5 Haiku)
```

### Three core flows

**1. Save**
The extension reads the current tab's URL and title via the Chrome Tabs API,
allows the user to edit the title and add a note, then POSTs to Lambda.
Lambda writes a structured bookmark item to DynamoDB with a timestamp-based ID.

**2. Semantic Search**
The user types a natural language query. Lambda fetches all bookmarks from DynamoDB,
formats them into a structured prompt, and sends both to Claude 3.5 Haiku via Bedrock.
Claude returns a ranked JSON array of relevant bookmarks with reasoning for each match.
Results are rendered dynamically in the extension popup.

**3. Delete**
Each bookmark card has a delete action. Lambda calls DynamoDB's `DeleteCommand`
with the bookmark's composite key (`userId` + `id`), removing it instantly.
The UI updates without reloading the full list.

---

## Architecture Decisions

**Why serverless (Lambda)?**
No server to provision, manage, or pay for when idle. Lambda runs only when
the extension makes a request — perfect for a personal tool with sporadic,
low-volume usage.

**Why DynamoDB?**
Schema-less NoSQL fits bookmark data well — each item can have optional fields
(note, custom title) without requiring schema migrations. PAY_PER_REQUEST billing
means zero cost at low usage. The `userId` partition key + `id` sort key design
allows efficient per-user queries as the dataset grows.

**Why Claude via Bedrock instead of keyword search?**
Keyword search requires exact title matches. Claude understands semantic intent —
a search for *"making Python run tasks concurrently"* correctly surfaces a bookmark
titled *"Python Docs"* with a note *"async reference"* because Claude understands
the conceptual relationship. This is the core value proposition of MindMark.

**Why a single Lambda endpoint?**
Rather than separate API routes for save/search/list/delete, all actions flow
through one endpoint with an `action` field in the request body. This kept the
API Gateway configuration minimal and made the Lambda logic easy to extend
without touching infrastructure. This structure may evolve as MindMark receives
further user feedback.

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Extension | Chrome Manifest V3, vanilla JS | No framework overhead, direct Chrome API access |
| Backend | AWS Lambda, Node.js 20 | Serverless, scales to zero, no idle cost |
| Database | AWS DynamoDB | Schema-less, serverless, PAY_PER_REQUEST |
| AI | Claude 3.5 Haiku via AWS Bedrock | Fast, cost-efficient, semantic understanding |
| API | AWS API Gateway v2 HTTP API | Managed HTTPS, CORS handling, Lambda integration |

---

## Try It (Interview Demo)

> This section is for anyone who wants to see MindMark
> running live against the deployed backend.

**Prerequisites:** Google Chrome

**Steps:**
1. Clone or download this repo
2. Open Chrome and go to `chrome://extensions`
3. Toggle **Developer mode** ON (top right corner)
4. Click **Load unpacked**
5. Select the `extension/` folder from this repo
6. Click the 🔖 MindMark icon that appears in your Chrome toolbar

**Using the extension:**
- **Save tab** — the current page's URL and title are pre-filled. Edit the title
  if you want, add an optional note, and click **Save This Page**
- **Search** — type any natural language query and hit Search or press Enter.
  Claude will return the most semantically relevant bookmarks with a reason for each match
- **Bookmarks tab** — view all saved bookmarks sorted newest first.
  Click any title to open the page. Click 🗑️ to delete

> ⚠️ **Note:** This demo connects to a shared backend. Bookmarks you save will be
> visible to anyone else using this demo instance, and will persist in the database.
> Please don't save anything sensitive. For a private instance, see Self-Hosting below.

---

## Self-Hosting

> For developers who want to deploy their own private instance with their own
> AWS account and their own database.

### Prerequisites
- AWS account — [create one here](https://aws.amazon.com)
- AWS CLI v2 — `brew install awscli` on Mac
- Node.js 18+ — `brew install node` on Mac
- Google Chrome

### 1. AWS CLI setup

Create an IAM user in AWS Console → IAM → Users → Create user.
Attach these policies directly:
- `AmazonDynamoDBFullAccess`
- `AWSLambda_FullAccess`
- `AmazonBedrockFullAccess`
- `AmazonAPIGatewayAdministrator`
- `IAMFullAccess`

Create an access key (CLI use case) and configure:
```bash
aws configure
# Enter your Access Key ID, Secret Access Key, region: us-east-1, format: json
```

### 2. Create DynamoDB table
```bash
aws dynamodb create-table \
  --table-name mindmark-bookmarks \
  --attribute-definitions \
    AttributeName=userId,AttributeType=S \
    AttributeName=id,AttributeType=S \
  --key-schema \
    AttributeName=userId,KeyType=HASH \
    AttributeName=id,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1
```

### 3. Deploy Lambda
```bash
cd backend
npm install
zip -r function.zip index.mjs node_modules package.json
```

Create the execution role:
```bash
aws iam create-role \
  --role-name mindmark-lambda-role \
  --assume-role-policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

aws iam attach-role-policy --role-name mindmark-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess

aws iam attach-role-policy --role-name mindmark-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonBedrockFullAccess

aws iam attach-role-policy --role-name mindmark-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

> Get your account ID: `aws sts get-caller-identity --query Account --output text`

Deploy:
```bash
aws lambda create-function \
  --function-name mindmark-api \
  --runtime nodejs20.x \
  --role arn:aws:iam::YOUR_ACCOUNT_ID:role/mindmark-lambda-role \
  --handler index.handler \
  --zip-file fileb://function.zip \
  --timeout 30 \
  --region us-east-1
```

### 4. Set up API Gateway
```bash
# Create API — note the ApiId in the output
aws apigatewayv2 create-api \
  --name mindmark-api \
  --protocol-type HTTP \
  --cors-configuration AllowOrigins="*",AllowMethods="POST,OPTIONS",AllowHeaders="Content-Type"

# Create integration — note the IntegrationId in the output
aws apigatewayv2 create-integration \
  --api-id YOUR_API_ID \
  --integration-type AWS_PROXY \
  --integration-uri arn:aws:lambda:us-east-1:YOUR_ACCOUNT_ID:function:mindmark-api \
  --payload-format-version 1.0

# Create route
aws apigatewayv2 create-route \
  --api-id YOUR_API_ID \
  --route-key "POST /" \
  --target integrations/YOUR_INTEGRATION_ID

# Create stage
aws apigatewayv2 create-stage \
  --api-id YOUR_API_ID \
  --stage-name prod \
  --auto-deploy

# Grant permission
aws lambda add-permission \
  --function-name mindmark-api \
  --statement-id apigateway-invoke \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:us-east-1:YOUR_ACCOUNT_ID:YOUR_API_ID/*/*" \
  --region us-east-1
```

> ⚠️ API Gateway v2 requires a trailing slash on the URL to match the root route.
> Your endpoint is: `https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/prod/`

### 5. Update the extension

Open `extension/popup.js` and update line 1:
```javascript
const API_URL = "https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/prod/";
```

Then load the extension in Chrome following the steps in the Try It section above.

---

## Known Limitations

| Limitation | Detail |
|---|---|
| No authentication | All bookmarks stored under a hardcoded `userId`. In production this would use AWS Cognito or similar. |
| Shared demo instance | The public demo uses a single shared database. Don't save sensitive content — use self-hosting for privacy. |
| No pagination | All bookmarks are fetched in one DynamoDB query and sent to Claude. Works well for personal use (hundreds of bookmarks) but would need pagination at scale. |
| Cold starts | Lambda functions that haven't been invoked recently take 1–3 seconds to wake up on the first call. Subsequent calls are fast. |
| Chrome only | Uses Manifest V3 and Chrome-specific APIs. Not tested on Firefox or other browsers. |
| Search quality scales with volume | Semantic search is more impressive and useful with a larger, more diverse bookmark collection. |

---

## Project Structure
```
mindmark-prototype1/
├── backend/
│   ├── index.mjs        ← Lambda function (save, search, list, delete)
│   └── package.json     ← Node.js dependencies
├── extension/
│   ├── manifest.json    ← Chrome extension config (Manifest V3)
│   ├── popup.html       ← Extension UI structure
│   ├── popup.css        ← Styling
│   └── popup.js         ← UI logic, Chrome API calls, AWS API integration
└── README.md
```

---

## Built With

[AWS Lambda](https://aws.amazon.com/lambda/) ·
[AWS DynamoDB](https://aws.amazon.com/dynamodb/) ·
[AWS Bedrock](https://aws.amazon.com/bedrock/) ·
[Anthropic Claude 3.5 Haiku](https://www.anthropic.com) ·
[AWS API Gateway](https://aws.amazon.com/api-gateway/) ·
Chrome Extensions Manifest V3

---

*Built by [Chandana Robba](https://github.com/CSRobba) — University of Washington -- Computer Science*

---

## License

MIT