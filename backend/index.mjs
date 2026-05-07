import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

// ============================================================
// MindMark — index.mjs (Lambda function)
// Handles: save, list, search, delete
// Deployed to AWS Lambda, triggered via API Gateway
// ============================================================

// ── AWS Clients ───────────────────────────────────────────────
// Created once when Lambda starts — reused across warm invocations
// for performance. Avoids reconnecting on every request.
const dynamo  = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const bedrock = new BedrockRuntimeClient({ region: "us-east-1" });

const TABLE = "mindmark-bookmarks";

// ⚠️ If this model is deprecated, replace with any active Anthropic
// model ID from: https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html
const MODEL = "us.anthropic.claude-3-5-haiku-20241022-v1:0";

// ── Main Handler ──────────────────────────────────────────────
// Entry point — AWS calls this function for every incoming request.
// Routes to the correct action based on the "action" field in the body.
// index.handler in the Lambda config means: file=index, function=handler
export const handler = async (event) => {
    console.log("Incoming event:", JSON.stringify(event));

    // CORS headers — required so the Chrome extension (a different origin)
    // is allowed to call this API. * means any domain can call — fine for prototype.
    const headers = {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Content-Type":                 "application/json",
    };

    // Browsers send a preflight OPTIONS request before every POST
    // to confirm the server allows cross-origin calls. Return 200 immediately.
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers, body: "" };
    }

    try {
        const body     = JSON.parse(event.body || "{}");
        const { action } = body;

        // Route to the correct handler based on the action field.
        // The extension sets action = "save" | "search" | "list" | "delete"
        if (action === "save") {
            return await saveBookmark(body, headers);
        } else if (action === "search") {
            return await searchBookmarks(body, headers);
        } else if (action === "list") {
            return await listBookmarks(body, headers);
        } else if (action === "delete") {
            return await deleteBookmark(body, headers);
        } else {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "Unknown action. Use: save, search, list, or delete" }),
            };
        }
    } catch (err) {
        console.error("Handler error:", err);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: err.message }),
        };
    }
};

// ── Save Bookmark ─────────────────────────────────────────────
// Writes a new bookmark item to DynamoDB.
// userId is hardcoded as "demo-user" — replaced with real auth in Phase 6.
// id is a timestamp-based unique string like "bm-1711234567890".
async function saveBookmark({ url, title, note = "" }, headers) {
    if (!url || !title) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: "url and title are required" }),
        };
    }

    const item = {
        userId:  "demo-user",
        id:      `bm-${Date.now()}`,
        url,
        title,
        note,
        savedAt: new Date().toISOString(),
        tags:    [],  // starts empty — filled async by generateAndStoreTags
    };

    // PutCommand = INSERT — writes the item to DynamoDB.
    // If an item with the same userId + id already exists it is overwritten,
    // but since id is timestamp-based that won't happen in practice.
    await dynamo.send(new PutCommand({ TableName: TABLE, Item: item }));

    // Await tag generation — adds ~1-2 seconds to save time but ensures
    // tags are stored before response returns. Lambda freezes execution
    // on return so truly async background work gets killed before finishing.
    try {
        await generateAndStoreTags(item);
    } catch (err) {
        // Tag generation failing should never block a successful save
        console.error("Tag generation failed:", err);
    }

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, bookmark: item }),
    };
}

// ── Generate and Store Tags ───────────────────────────────────
// Called asynchronously after save — never blocks the save response.
// Asks Claude to generate 1-3 short tags for the bookmark based on
// its title and URL, then updates the DynamoDB item with those tags.
async function generateAndStoreTags({ userId, id, title, url }) {
    const prompt = `You are a bookmark tagging assistant.

Given this bookmark:
Title: "${title}"
URL: "${url}"

Generate 1 to 3 short, lowercase tags that best describe the topic or category.
Tags should be generic enough to group related bookmarks together.
Good examples: "machine-learning", "recipe", "javascript", "career", "research", "productivity"
Bad examples: "interesting", "read-later", "link" (too vague)

Return ONLY a JSON array of strings. No explanation, no markdown, no code blocks.
Example: ["python", "tutorial"]`;

    const bedrockResponse = await bedrock.send(new InvokeModelCommand({
        modelId:     MODEL,
        contentType: "application/json",
        accept:      "application/json",
        body: JSON.stringify({
            anthropic_version: "bedrock-2023-05-31",
            max_tokens:        100,
            messages: [{ role: "user", content: prompt }],
        }),
    }));

    const responseBody = JSON.parse(new TextDecoder().decode(bedrockResponse.body));
    const claudeText   = responseBody.content[0].text;

    // Strip any accidental markdown fences and parse the JSON array
    const cleaned = claudeText.replace(/```json|```/g, "").trim();
    const tags    = JSON.parse(cleaned);

    if (!Array.isArray(tags)) return;

    // Update the DynamoDB item with the generated tags.
    // UpdateExpression = SET tags = :tags on the specific item.
    await dynamo.send(new UpdateCommand({
        TableName:                 TABLE,
        Key:                       { userId, id },
        UpdateExpression:          "SET tags = :tags",
        ExpressionAttributeValues: { ":tags": tags },
    }));

    console.log(`Tags generated for ${id}:`, tags);
}

// ── List Bookmarks ────────────────────────────────────────────
// Fetches all bookmarks for the current user from DynamoDB.
// QueryCommand scans only the user's partition (userId = "demo-user")
// rather than the whole table — efficient regardless of total table size.
async function listBookmarks(_, headers) {
    const result = await dynamo.send(new QueryCommand({
        TableName:                 TABLE,
        KeyConditionExpression:    "userId = :uid",
        ExpressionAttributeValues: { ":uid": "demo-user" },
    }));

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ bookmarks: result.Items || [] }),
    };
}

// ── Search Bookmarks ──────────────────────────────────────────
// The AI-powered search flow:
//   1. Fetch all bookmarks from DynamoDB
//   2. Pre-filter to top 30 candidates using keyword matching
//      (keeps Claude's context small as the library grows)
//   3. Send candidates + query to Claude via Bedrock
//   4. Claude returns up to 10 ranked results with relevance scores
async function searchBookmarks({ query, userId = "demo-user" }, headers) {
    if (!query) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: "query is required" }),
        };
    }

    // Step 1: Fetch all bookmarks for this user from DynamoDB
    const result = await dynamo.send(new QueryCommand({
        TableName:                 TABLE,
        KeyConditionExpression:    "userId = :uid",
        ExpressionAttributeValues: { ":uid": userId },
    }));

    const bookmarks = result.Items || [];

    if (bookmarks.length === 0) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ results: [], message: "No bookmarks saved yet" }),
        };
    }

    // Step 2: Pre-filter — keyword match to reduce candidate pool.
    // Without this, a library of 200+ bookmarks would fill Claude's context
    // window, causing slow responses and higher costs.
    // We score each bookmark by how many query words appear in its
    // title, URL, or note, then keep the top 30 candidates.
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

    const candidatePool = bookmarks
        .map(b => {
            const haystack = `${b.title} ${b.url} ${b.note || ""}`.toLowerCase();
            const hits     = queryWords.filter(w => haystack.includes(w)).length;
            return { ...b, _hits: hits };
        })
        .sort((a, b) => b._hits - a._hits)
        .slice(0, 30);

    // Step 3: Format the candidate pool for Claude to read
    const bookmarkList = candidatePool
        .map((b, i) =>
            `[${i + 1}] Title: "${b.title}" | URL: ${b.url} | Note: "${b.note || "none"}" | Saved: ${b.savedAt || "unknown"}`
        )
        .join("\n");

    // Step 4: Build the prompt.
    // We ask Claude for up to 10 results with a 0-100 relevance score each.
    // Explicit JSON field names prevent Claude from returning inconsistent formats.
    const prompt = `You are a semantic bookmark search assistant.

The user has these saved bookmarks:
${bookmarkList}

The user is searching for: "${query}"

Return up to 10 of the most relevant bookmarks ranked by relevance score.
For each match return:
- index: the bookmark number from the list above
- title: the bookmark title
- url: the bookmark URL
- savedAt: the saved date
- reason: ONE sentence explaining why it matches the query
- score: a relevance score from 0 to 100 (100 = perfect match):

Scoring rules:
- 90 to 100 = exact or highly relevant match
- 70 to 89 = strong relevance
- 50 to 69 = somewhat relevant
- below 50 = weak relevance

Only include bookmarks that are genuinely relevant — do NOT pad to 10 if fewer are relevant.
If nothing is relevant, return an empty array.
Return ONLY a valid JSON array with fields: index, title, url, savedAt, reason, score.
No markdown, no explanation, no code blocks — just the raw JSON array.`;

    // Step 5: Call Claude via Bedrock
    const bedrockResponse = await bedrock.send(new InvokeModelCommand({
        modelId:     MODEL,
        contentType: "application/json",
        accept:      "application/json",
        body: JSON.stringify({
            anthropic_version: "bedrock-2023-05-31",
            max_tokens:        1024,
            messages: [{ role: "user", content: prompt }],
        }),
    }));

    // Step 6: Parse Claude's response.
    // Bedrock returns raw bytes — TextDecoder converts to string,
    // then we parse the Bedrock wrapper and then Claude's inner JSON.
    const responseBody = JSON.parse(new TextDecoder().decode(bedrockResponse.body));
    const claudeText   = responseBody.content[0].text;

    let results;
    try {
        // Strip any accidental markdown code fences Claude might add
        const cleaned = claudeText.replace(/```json|```/g, "").trim();
        results = JSON.parse(cleaned);
    } catch {
        // If Claude returns something unparseable, pass it through
        // so the extension can show a graceful error
        results = claudeText;
    }

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ results, query }),
    };
}

// ── Delete Bookmark ───────────────────────────────────────────
// Removes a single bookmark from DynamoDB by composite key (userId + id).
// DynamoDB requires both parts of the key to locate and delete the item.
async function deleteBookmark({ id, userId = "demo-user" }, headers) {
    if (!id) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: "id is required" }),
        };
    }

    await dynamo.send(new DeleteCommand({
        TableName: TABLE,
        Key: { userId, id },
    }));

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, deleted: id }),
    };
}