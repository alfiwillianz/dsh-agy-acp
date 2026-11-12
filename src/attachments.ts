import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { FileAttachmentLike, ImageAttachmentLike, PromptAttachmentResolver } from './prompt.js'
import { NO_ATTACHMENTS } from './prompt.js'

/* ----------------------------------------------------------------------------------------------------------------
 * dsh attachment store -> ACP prompt content.
 *
 * The attachment service is optional and lives in a separate package (`@deepseek-ai/dsh-attachment`). We depend on
 * its structural shape only, so this plugin keeps working when attachments are not composed (images/files then
 * become explicit placeholders instead of being silently dropped).
 * -------------------------------------------------------------------------------------------------------------- */

interface AttachmentStoreLike {
  readImage(ref: unknown, signal?: AbortSignal): Promise<{ ref: { mediaType: string }; data: Uint8Array }>
  fileHostPath(ref: unknown): string | undefined
  readFileStream(ref: unknown, signal?: AbortSignal): AsyncIterable<Uint8Array>
}

/** Keep embedded text files from turning a prompt into an unbounded payload. */
const MAX_EMBEDDED_FILE_BYTES = 512 * 1024

async function readTextFile(store: AttachmentStoreLike, ref: FileAttachmentLike, signal?: AbortSignal): Promise<string | undefined> {
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for await (const chunk of store.readFileStream(ref, signal)) {
      total += chunk.byteLength
      if (total > MAX_EMBEDDED_FILE_BYTES) return undefined
      chunks.push(chunk)
    }
  } catch {
    return undefined
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map((c) => Buffer.from(c))))
  } catch {
    return undefined
  }
}

/**
 * Build a resolver backed by the composed attachment store, or the no-op resolver when attachments are absent or
 * the feature is disabled. Every failure degrades to `undefined`, which the prompt builder turns into a warning
 * and a visible placeholder.
 */
export function createAttachmentResolver(ctx: Context, enabled: boolean): PromptAttachmentResolver {
  if (!enabled) return NO_ATTACHMENTS
  const store = ctx.get('attachments', false) as AttachmentStoreLike | undefined
  if (store === undefined) return NO_ATTACHMENTS
  return {
    async image(ref: ImageAttachmentLike) {
      if (ref.attachmentId === undefined) return undefined
      try {
        const stored = await store.readImage(ref)
        return { data: Buffer.from(stored.data).toString('base64'), mimeType: stored.ref.mediaType }
      } catch {
        return undefined
      }
    },
    async file(ref: FileAttachmentLike) {
      if (ref.attachmentId === undefined) return undefined
      const name = ref.name ?? 'file'
      const size = ref.bytes
      try {
        const hostPath = store.fileHostPath(ref)
        if (hostPath !== undefined) {
          return { uri: pathToFileURL(hostPath).href, name, ...(size === undefined ? {} : { size }) }
        }
        const text = await readTextFile(store, ref)
        if (text !== undefined) {
          return { uri: `attachment://${ref.attachmentId}`, name, text, mimeType: 'text/plain' }
        }
      } catch {
        /* fall through to the placeholder */
      }
      return undefined
    },
  }
}
