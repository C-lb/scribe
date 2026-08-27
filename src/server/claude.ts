import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import type { Config } from "./config.js";
import type { TranscriptFlag } from "./transcript-file.js";
import { formatTimestamp, type TranscriptLine } from "./transcript.js";

export const RunningSummarySchema = z.object({
  topics: z.array(z.string()),
  keyPoints: z.array(z.string()),
  definitions: z.array(z.object({ term: z.string(), definition: z.string() })),
  flagged: z.array(z.string()),
  openQuestions: z.array(z.string()),
});

export type RunningSummary = z.infer<typeof RunningSummarySchema>;

/**
 * Frozen. Prompt caching is a prefix match, so a single varying byte here
 * invalidates the cached transcript on every request.
 */
export const RUNNING_SYSTEM_PROMPT = [
  "You are taking notes on a university lecture as it happens.",
  "",
  "You receive the transcript so far and your previous summary. Return an",
  "updated summary of the whole lecture so far — not a summary of only the new",
  "material, and not an edit of the previous one. Rewrite it whole.",
  "",
  "The transcript comes from automatic speech recognition, so expect garbled",
  "words and missing punctuation. Where a term is obviously mistranscribed but",
  "recoverable from context, use the correct term. Never invent content that is",
  "not in the transcript; a thin summary of a thin transcript is correct.",
  "",
  "Sections:",
  "- topics: what has been covered, in the order covered.",
  "- keyPoints: the claims, arguments, and results worth remembering.",
  "- definitions: terms the lecturer introduced, with their definitions.",
  "- flagged: anything the lecturer marked as important, examinable, or",
  "  assessed. Include their wording where it signals emphasis.",
  "- openQuestions: raised but not resolved, including questions from the room.",
  "",
  "Segments marked [inaudible] are dropped audio. Do not comment on them.",
].join("\n");

const FINAL_SYSTEM_PROMPT = [
  "You are writing up notes from a full lecture transcript.",
  "",
  "Produce a Markdown document a student can revise from without replaying the",
  "lecture. Lead with a short overview, then the substance organised by topic,",
  "then a definitions list, then anything the lecturer flagged as examinable.",
  "",
  "The transcript comes from automatic speech recognition. Correct obvious",
  "mistranscriptions where context makes the intended term clear, and never add",
  "material that is not in the transcript.",
  "",
  "Segments marked [inaudible] are dropped audio. Do not comment on them.",
].join("\n");

export function buildRunningMessages(
  transcript: string,
  previous: RunningSummary | null,
): Anthropic.MessageParam[] {
  return [
    {
      role: "user",
      content: [
        // Stable, growing prefix — cached. Must come first.
        {
          type: "text",
          text: `<transcript>\n${transcript}\n</transcript>`,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
        // Volatile — changes every pass, so it sits after the breakpoint.
        {
          type: "text",
          text: previous
            ? `<previous_summary>\n${JSON.stringify(previous, null, 2)}\n</previous_summary>\n\nUpdate the summary to cover the whole transcript above.`
            : "There is no previous summary. Write the first one from the transcript above.",
        },
      ],
    },
  ];
}

/**
 * Appended to the final Markdown after the model returns, never asked for in
 * the prompt: the flags are ground truth from the person in the room, and a
 * model handed them as prose might paraphrase or drop one. A session with no
 * flags gets no section at all -- an empty "Marked in the room" heading would
 * be worse than not mentioning it.
 */
export function appendFlagsSection(
  markdown: string,
  flags: TranscriptFlag[],
  lines: TranscriptLine[],
): string {
  if (flags.length === 0) return markdown;

  const items = flags.map((flag) => {
    const line = flag.chunkIndex !== null
      ? lines.find((l) => l.index === flag.chunkIndex)
      : undefined;
    const text = line?.text ?? "(no transcript line at this moment)";
    return `- **${formatTimestamp(flag.atMs)}** ${text}`;
  });

  return `${markdown}\n\n## Marked in the room\n\n${items.join("\n")}`;
}

export function createSummariser(config: Config) {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  return {
    async running(
      transcript: string,
      previous: RunningSummary | null,
    ): Promise<RunningSummary> {
      const response = await client.messages.parse({
        model: config.runningModel,
        max_tokens: 8000,
        system: [
          {
            type: "text",
            text: RUNNING_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
        messages: buildRunningMessages(transcript, previous),
        output_config: {
          effort: "low",
          format: zodOutputFormat(RunningSummarySchema),
        },
      });

      if (!response.parsed_output) {
        throw new Error("Claude returned a running summary that failed to parse");
      }
      console.log(
        `[scribe] running summary: ${response.usage.input_tokens} new, ` +
          `${response.usage.cache_read_input_tokens ?? 0} cached`,
      );
      return response.parsed_output;
    },

    async final(transcript: string): Promise<string> {
      // Streaming: a full lecture transcript plus a long Markdown response is
      // exactly the case where a non-streaming request hits an HTTP timeout.
      const stream = client.messages.stream({
        model: config.finalModel,
        max_tokens: 32000,
        system: [
          {
            type: "text",
            text: FINAL_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `<transcript>\n${transcript}\n</transcript>`,
                cache_control: { type: "ephemeral", ttl: "1h" },
              },
              { type: "text", text: "Write the revision notes for this lecture." },
            ],
          },
        ],
      });

      const message = await stream.finalMessage();
      return message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
    },
  };
}
