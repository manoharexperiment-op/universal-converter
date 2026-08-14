/**
 * Bridging wasm output into a Blob.
 *
 * TypeScript 5.7 made `Uint8Array` generic over its backing buffer, and
 * `BlobPart` only accepts one backed by a plain `ArrayBuffer`. Anything typed as
 * `Uint8Array<ArrayBufferLike>` (which is what ffmpeg, qpdf, pdf-lib and
 * onnxruntime all hand back) therefore fails to assign, because the compiler
 * cannot rule out a `SharedArrayBuffer`.
 *
 * In this app it never is one: `SharedArrayBuffer` requires cross-origin
 * isolation, which is deliberately not enabled, since the COOP/COEP headers it
 * needs break the OCR worker. Every engine here is single-threaded for exactly
 * that reason.
 *
 * So the narrowing is safe, and doing it in one named place beats scattering
 * casts across a dozen call sites or copying tens of megabytes to satisfy the
 * type checker.
 */
export function blobBytes(data: Uint8Array): BlobPart {
  return data as unknown as BlobPart;
}
