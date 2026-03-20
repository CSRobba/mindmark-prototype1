import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

// ── Clients ──────────────────────────────────────────────────────────────────
// These are reused across invocations — Lambda keeps them warm between calls
/*
* These lines create the connections to DynamoDB and Bedrock once when Lambda first starts up.
* Lambda keeps these "warm" between calls so you're not reconnecting on every single request —
* this is a performance best practice. TABLE and MODEL are constants defined at the top so if
* you ever need to change the table name or swap Claude models, you change it in one place instead
* of hunting through the whole file.
*
* */
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const bedrock = new BedrockRuntimeClient({ region: "us-east-1" });

const TABLE = "mindmark-bookmarks";
const MODEL = "us.anthropic.claude-3-5-haiku-20241022-v1:0";

// ── Main Handler ─────────────────────────────────────────────────────────────
// This is the entry point — Lambda calls this function for every request
/*
*
* This is the entry point — the function AWS calls when your extension hits the API. The
* name handler matches what you'll tell Lambda when deploying (index.handler = "in the file
* index, call the function named handler").
*
* event is the entire incoming request — it contains the HTTP method, headers, and crucially
* the body which is the JSON your extension sends.
*
* */
export const handler = async (event) => {
    console.log("Incoming event:", JSON.stringify(event));

    // CORS headers — required so the Chrome extension can call this API
    /*
    * Browsers have a security rule called CORS (Cross-Origin Resource Sharing) that
    * blocks JavaScript from calling APIs on different domains unless the API explicitly
    * says "I allow this." The * in Allow-Origin means "any domain can call me" — fine for
    * a prototype.
    * */
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Content-Type": "application/json",
    };

    // Handle preflight CORS check that browsers send before every POST
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers, body: "" };
    }
/*
* Parse the JSON the extension sent. Extract action — this is the routing key.
* The extension tells Lambda what to do by setting action to "save", "search", or "list".
* */
    try {
        const body = JSON.parse(event.body || "{}");
        const { action } = body;

        if (action === "save") {
            return await saveBookmark(body, headers);
        } else if (action === "search") {
            return await searchBookmarks(body, headers);
        } else if (action === "list") {
            return await listBookmarks(body, headers);
        } else {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "Unknown action. Use: save, search, or list" }),
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

// ── Save Bookmark ─────────────────────────────────────────────────────────────
// Writes a new bookmark item to DynamoDB
/*
* Builds the object to store. userId is hardcoded as "demo-user" for the prototype —
* in real product this would come from user authentication. Date.now() generates a
* unique timestamp-based ID like bm-1711234567890. toISOString() gives a clean timestamp
* like 2026-03-19T10:30:00Z.
* */
async function saveBookmark({ url, title, note = "" }, headers) {
    if (!url || !title) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: "url and title are required" }),
        };
    }

    // Build the item we'll store in DynamoDB
    const item = {
        userId: "demo-user",           // Fixed for prototype — in production this would be auth'd
        id: `bm-${Date.now()}`,        // Unique ID based on timestamp
        url,
        title,
        note,
        savedAt: new Date().toISOString(),
    };

    // PutCommand = INSERT in SQL terms
    await dynamo.send(new PutCommand({ TableName: TABLE, Item: item }));

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, bookmark: item }),
    };
}

// ── List Bookmarks ────────────────────────────────────────────────────────────
// Fetches all bookmarks for the demo user from DynamoDB
async function listBookmarks(_, headers) {
    // QueryCommand fetches all items with a matching partition key (userId)
    const result = await dynamo.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "userId = :uid",
        ExpressionAttributeValues: { ":uid": "demo-user" },
    }));

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ bookmarks: result.Items || [] }),
    };
}

// ── Search Bookmarks ──────────────────────────────────────────────────────────
// This is the AI part — sends bookmarks + query to Claude, returns ranked results
async function searchBookmarks({ query, userId = "demo-user" }, headers) {
    if (!query) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: "query is required" }),
        };
    }

    // Step 1: Fetch all bookmarks from DynamoDB
    const result = await dynamo.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "userId = :uid",
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

    // Step 2: Format bookmarks for Claude to read
    const bookmarkList = bookmarks
        .map((b, i) => `[${i + 1}] Title: "${b.title}" | URL: ${b.url} | Note: "${b.note || "none"}"`)
        .join("\n");

    // Step 3: Build the prompt — this is what we send to Claude
    const prompt = `You are a semantic bookmark search assistant.

The user has these saved bookmarks:
${bookmarkList}

The user is searching for: "${query}"

Return the most relevant bookmarks ranked by relevance. For each match return:
- The bookmarked date
- Title
- URL  
- A one-sentence reason why it matches

If nothing is relevant, say so honestly. Return results as JSON array with fields: savedAt, title, url, reason.
Only return the JSON array, no other text.`;

    // Step 4: Call Claude via Bedrock
    const bedrockResponse = await bedrock.send(new InvokeModelCommand({
        modelId: MODEL,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 1024,
            messages: [{ role: "user", content: prompt }],
        }),
    }));

    // Step 5: Parse Claude's response
    const responseBody = JSON.parse(new TextDecoder().decode(bedrockResponse.body));
    const claudeText = responseBody.content[0].text;

    let results;
    try {
        results = JSON.parse(claudeText);
    } catch {
        // If Claude didn't return clean JSON, return the raw text
        results = claudeText;
    }

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ results, query }),
    };
}
