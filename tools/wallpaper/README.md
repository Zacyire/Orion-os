# Wallpaper renderer

Renders `scene.html` (a procedural, seamlessly looping landscape) frame-by-frame
and encodes it to VP9 WebM with WebCodecs, so output is a smooth 30 fps
regardless of how fast the machine renders.

```bash
cd tools/wallpaper
npm i playwright webm-muxer@5
node render.mjs            # → aurora.webm (1920×1080, 16 s loop)
cp aurora.webm ../../static/media/wallpapers/aurora-ridge.webm
```

Every animated term in `scene.html` is periodic in `T`, so the last frame
flows into the first without a seam.
