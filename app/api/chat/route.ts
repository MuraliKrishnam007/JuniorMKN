import { NextRequest, NextResponse } from "next/server"; // Using NextResponse for consistency
import { Readable } from 'stream'; // This is actually not used by your ReadableStream implementation
import { Together } from 'together-ai'; // Ensure you have the Together package installed

interface MessageParam {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Maximum duration (in seconds) that this function can run.
 * Adjust based on platform limits (e.g., Netlify, Vercel) and expected API response times.
 * Should be slightly longer than API_CALL_TIMEOUT_MS.
 */
export const maxDuration = 60; // Example: 60 seconds

// Ensure TOGETHER_API_KEY is set in your .env.local file
const apiKey = process.env.TOGETHER_API_KEY;
const systemMessage = "Default system prompt message.";

/**
 * Timeout for the outgoing API call to Together AI in milliseconds.
 * If the API call takes longer than this, it will be aborted.
 */
const API_CALL_TIMEOUT_MS = 55000; // 55 seconds

export async function POST(request: NextRequest) {
  console.log(`[${new Date().toISOString()}] POST /api/chat (Together AI) - Request received.`);
  const requestProcessingStartTime = Date.now();

  if (!apiKey) {
    console.error(`[${new Date().toISOString()}] TOGETHER_API_KEY not configured.`);
    return new NextResponse("API key not configured", { status: 500 });
  }

  const abortController = new AbortController();
  let timeoutId: NodeJS.Timeout | null = null;

  timeoutId = setTimeout(() => {
    console.warn(
      `[${new Date().toISOString()}] Together AI API call explicitly timed out by AbortController after ${API_CALL_TIMEOUT_MS / 1000}s. Aborting request.`
    );
    abortController.abort("API Call Timeout");
  }, API_CALL_TIMEOUT_MS);

  console.log(
    `[${new Date().toISOString()}] AbortController timeout set for ${API_CALL_TIMEOUT_MS / 1000}s for the Together AI API request.`
  );

  try {
    const { messages } = await request.json();

    if (!messages || !Array.isArray(messages)) {
      if (timeoutId) clearTimeout(timeoutId);
      console.warn(
        `[${new Date().toISOString()}] Invalid request body: 'messages' array is required.`
      );
      return new NextResponse("Invalid request body: 'messages' array is required.", { status: 400 });
    }

    console.log(
      `[${new Date().toISOString()}] Valid request received. Messages count: ${messages.length}.`
    );

    const preparedMessages: MessageParam[] = [
      { role: 'system', content: systemMessage },
      ...messages.map((message: { role: string; content: string; }) => ({
          role: message.role as 'system' | 'user' | 'assistant',
          content: message.content
        })),
    ];

    const client = new Together({
      apiKey: apiKey,
      // You could also pass default request options here if needed,
      // but per-request options are generally more flexible.
    });

    console.log(`[${new Date().toISOString()}] Making request to Together AI...`);
    const fetchStartTime = Date.now();

    // Make a request to the Together API, passing the AbortSignal
    // The second argument to `create` is typically for RequestOptions
    const response = await client.chat.completions.create(
      {
        model: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free", // Or your desired model
        messages: preparedMessages,
        // stream: false (this is implicit for this type of call, which is non-streaming from the SDK perspective)
      },
      { // RequestOptions
        signal: abortController.signal,
      }
    );

    if (timeoutId) clearTimeout(timeoutId); // Clear the timeout as the API call has completed
    const fetchEndTime = Date.now();
    console.log(
      `[${new Date().toISOString()}] Together AI API call completed in ${fetchEndTime - fetchStartTime}ms. Status: SDK handled.`
    );
    // console.log(`[${new Date().toISOString()}] API Response from Together AI:`, response); // Log full response if needed for debugging

    if (!response.choices || response.choices.length === 0 || !response.choices[0].message || !response.choices[0].message.content) {
      console.error(`[${new Date().toISOString()}] Error: No content in Together AI response or unexpected structure.`, response);
      return new NextResponse("Error: No content in AI response or unexpected structure", { status: 500 });
    }

    const content = response.choices[0].message.content;
    console.log(`[${new Date().toISOString()}] Successfully received content from Together AI.`);

    // Your current implementation wraps the complete, non-streamed response content
    // into a new ReadableStream that sends the whole content in one go.
    const stream = new ReadableStream({
      start(controller) {
        console.log(`[${new Date().toISOString()}] Enqueuing full content to response stream.`);
        controller.enqueue(new TextEncoder().encode(content ?? ""));
        controller.close();
        console.log(`[${new Date().toISOString()}] Response stream closed.`);
      }
    });

    const totalProcessingTime = Date.now() - requestProcessingStartTime;
    console.log(`[${new Date().toISOString()}] Returning single-chunk stream to client. Total processing time: ${totalProcessingTime}ms.`);
    return new Response(stream, {
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });

  } catch (error: any) {
    if (timeoutId) clearTimeout(timeoutId); // Ensure timeout is cleared on any error path

    if (error.name === 'AbortError' || (error instanceof Error && error.message.includes("The operation was aborted"))) {
      console.error(
        `[${new Date().toISOString()}] Together AI API call aborted due to timeout (${API_CALL_TIMEOUT_MS / 1000}s). Error:`, error.message
      );
      return new NextResponse("The request to the AI service timed out.", {
        status: 504, // Gateway Timeout
      });
    }
    
    const totalProcessingTimeOnError = Date.now() - requestProcessingStartTime;
    console.error(
      `[${new Date().toISOString()}] Error in Together AI API call handler after ${totalProcessingTimeOnError}ms:`,
      error
    );
    // Log the specific error structure from the SDK if available
    if (error.response) {
        console.error(`[${new Date().toISOString()}] SDK Error Details:`, error.response?.data || error.response?.statusText);
    }
    return new NextResponse(
      `Error processing request: ${error instanceof Error ? error.message : "Unknown server error"}`,
      { status: 500 }
    );
  }
}

// Handle CORS preflight requests (OPTIONS)
export async function OPTIONS() {
  const response = new NextResponse(null);
  response.headers.set("Allow", "POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Origin", "*"); // Be more specific in production
  response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  response.headers.set("Access-Control-Max-Age", "86400");
  return response;
}
