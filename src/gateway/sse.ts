/**
 * Incremental SSE frame framing (Task 17, subtask 17.1).
 *
 * An upstream SSE body arrives as arbitrary byte chunks whose boundaries have
 * nothing to do with event boundaries: one chunk may carry three events, half an
 * event, or a single byte in the middle of a `data:` line. Every adapter already
 * knows how to parse a *complete* SSE block into {@link StreamEvent}s
 * (`ProviderAdapter.parseStreamEvent`), so the only thing missing for
 * chunk-by-chunk translation is a splitter that re-assembles whole blocks from a
 * chunk stream.
 *
 * {@link SseFrameSplitter} is that splitter: feed it chunks, get back the blocks
 * that are provably complete (terminated by a blank line), and it retains the
 * trailing partial block until the rest of it arrives. It never splits inside a
 * frame, so a downstream `parseStreamEvent` call always sees a well-formed
 * block -- which is what makes real time-to-first-token possible without
 * buffering the whole transcript first.
 */

/** Blank-line separator between SSE blocks, tolerating CRLF line endings. */
const FRAME_SEPARATOR = /\r?\n\r?\n/g;

/**
 * A stateful splitter turning an SSE byte/text chunk stream into whole frames.
 *
 * One splitter handles one stream; it is not reusable across streams because it
 * carries the partial-frame remainder between calls.
 */
export class SseFrameSplitter {
  /** Text received but not yet terminated by a blank line. */
  private buffer = '';

  /**
   * Consume one chunk of the stream.
   *
   * @param chunk Arbitrary text from the upstream body; may contain zero, one,
   *   or many frames, and may end mid-frame.
   * @returns The frames completed by this chunk, in order, each without its
   *   trailing blank-line separator. Empty when the chunk only extended a
   *   partial frame.
   */
  push(chunk: string): string[] {
    if (chunk.length === 0) {
      return [];
    }
    this.buffer += chunk;
    const frames: string[] = [];
    let consumed = 0;
    // Reset the shared regex: it is /g, so lastIndex persists between calls.
    FRAME_SEPARATOR.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FRAME_SEPARATOR.exec(this.buffer)) !== null) {
      const frame = this.buffer.slice(consumed, match.index);
      consumed = match.index + match[0].length;
      if (frame.trim().length > 0) {
        frames.push(frame);
      }
    }
    if (consumed > 0) {
      // Keep only the trailing partial frame; a lone "\n" or "\n\r" tail stays
      // buffered because it may yet turn out to be half of a separator.
      this.buffer = this.buffer.slice(consumed);
    }
    return frames;
  }

  /**
   * Finish the stream, releasing any trailing frame that was never terminated
   * by a blank line. Well-behaved upstreams end with a separator, so this is
   * usually empty; a truncated stream surfaces its last partial block here
   * rather than dropping it silently.
   */
  flush(): string[] {
    const rest = this.buffer;
    this.buffer = '';
    return rest.trim().length > 0 ? [rest] : [];
  }
}

/**
 * Re-frame a chunk stream into whole SSE blocks.
 *
 * @param chunks The raw upstream body, chunk by chunk.
 * @returns Complete SSE blocks, yielded as soon as each one is terminated.
 */
export async function* sseFrames(
  chunks: AsyncIterable<string>,
): AsyncIterable<string> {
  const splitter = new SseFrameSplitter();
  for await (const chunk of chunks) {
    for (const frame of splitter.push(chunk)) {
      yield frame;
    }
  }
  for (const frame of splitter.flush()) {
    yield frame;
  }
}
