// Test script to debug OpenCode event stream without Telegram
import { createOpencode, type Event, type TextPart, type ToolPart, type ReasoningPart, type StepFinishPart } from "@opencode-ai/sdk";

const OPENCODE_PORT = 4098; // Different port for testing

async function test() {
  console.log("Starting OpenCode...");
  const { client: opencode, server } = await createOpencode({
    port: OPENCODE_PORT,
    hostname: "127.0.0.1",
  });
  console.log(`OpenCode ready at ${server.url}`);

  // Create session
  const { data: session } = await opencode.session.create({
    body: { title: "Test Session" }
  });
  const sessionId = session?.id;
  console.log(`Session: ${sessionId}`);

  if (!sessionId) {
    console.error("No session ID");
    process.exit(1);
  }

  // Test message
  const userInput = "What files are in this directory?";
  console.log(`\n--- Sending: "${userInput}" ---\n`);

  // Subscribe to events
  const events = await opencode.event.subscribe();

  // Send prompt
  opencode.session.prompt({
    path: { id: sessionId },
    body: { parts: [{ type: "text", text: userInput }] }
  });

  // Track state
  let phase = "thinking";
  let textContent = "";
  const tools = new Map<string, { name: string; title: string; status: string }>();

  // Process events
  for await (const event of events.stream as AsyncIterable<Event>) {
    if (!("properties" in event)) continue;
    const props = event.properties as Record<string, unknown>;

    // Filter by session
    const evtSession = (props.sessionID as string) ?? 
      ((props.part as Record<string, unknown>)?.sessionID as string);
    if (evtSession && evtSession !== sessionId) continue;

    switch (event.type) {
      case "session.status": {
        const status = props.status as { type: string };
        console.log(`[status] ${status?.type}`);
        break;
      }

      case "message.part.updated": {
        const part = props.part as { type: string; sessionID?: string };
        if (part.sessionID !== sessionId) break;

        if (part.type === "reasoning") {
          const r = part as ReasoningPart;
          phase = "reasoning";
          console.log(`[reasoning] ${r.text.slice(0, 80)}...`);
        }
        else if (part.type === "tool") {
          const t = part as ToolPart;
          phase = "tools";
          const title = t.state.status === "running" || t.state.status === "completed"
            ? (t.state as { title?: string }).title || t.tool
            : t.tool;
          tools.set(t.callID, { name: t.tool, title, status: t.state.status });
          console.log(`[tool] ${t.tool} - ${title} (${t.state.status})`);
        }
        else if (part.type === "text") {
          const t = part as TextPart;
          // Check if this is user input
          const isUserInput = t.text === userInput;
          console.log(`[text] isUserInput=${isUserInput}, synthetic=${t.synthetic}, len=${t.text?.length}, preview="${t.text?.slice(0, 50)}..."`);
          
          if (t.text && t.text !== userInput) {
            phase = "responding";
            textContent = t.text;
          }
        }
        else if (part.type === "step-start") {
          console.log(`[step-start]`);
        }
        else if (part.type === "step-finish") {
          const s = part as StepFinishPart;
          console.log(`[step-finish] tokens: in=${s.tokens.input}, out=${s.tokens.output}, cost=$${s.cost.toFixed(4)}`);
        }
        break;
      }

      case "file.edited": {
        const file = props.file as string;
        console.log(`[file.edited] ${file}`);
        break;
      }

      case "session.idle": {
        console.log(`[session.idle]`);
        break;
      }
    }

    if (event.type === "session.idle") break;
  }

  console.log("\n--- FINAL STATE ---");
  console.log(`Phase: ${phase}`);
  console.log(`Tools used: ${[...tools.values()].map(t => t.name).join(", ")}`);
  console.log(`Response length: ${textContent.length}`);
  console.log(`Response preview: ${textContent.slice(0, 200)}...`);

  server.close();
  process.exit(0);
}

test().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
