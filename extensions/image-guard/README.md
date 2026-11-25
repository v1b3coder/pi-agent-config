# image-guard

Keeps images Pi sends to a model within what every provider accepts: **8-bit samples, one
frame, sRGB, PNG**. Registered on the `context` hook, so it runs before every model call —
including for images already persisted in the session.

## Why

Pi normalizes images for size and container format, but forwards any PNG/JPEG/GIF/WebP that
already fits the limits **byte for byte**. A 16-bit PNG therefore goes out with 16-bit
samples, vLLM answers

```
400 PNG requires non-animated, at most 8-bit samples
```

and because the image is already in the session, every later turn re-sends it. The thread is
dead for good (`read` on an 864×540 16-bit grayscale PNG killed a hromadkapp session this way).

## Behaviour

- Canonical images are returned untouched — identity-equal, no re-encode, only a 4 KB header read.
- Anything else (16-bit PNG, animated PNG/GIF/WebP, CMYK JPEG, BMP) is decoded and re-encoded
  as an 8-bit static PNG, or JPEG when the PNG would exceed the inline size limit.
- An image that cannot be decoded degrades to a `[Image omitted: …]` text block. It never fails
  the request.
- The declared MIME type is corrected from the bytes, since a mismatched type breaks data-URL decoding.
- Models without image input are skipped entirely — pi-ai already drops those images.

The header predicate is an optimization, never an admission decision: a false negative costs
one re-encode, not a rejected request.

## Tests

```
node --test test/
```

`test/fixtures/gray16.png` is the class that broke the session; the rest are animated, CMYK,
BMP and 8-bit controls.
