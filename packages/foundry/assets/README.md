# Assets

`foundry-bot.svg` is the bot icon of the public Foundry GitHub App: a chimney with the flame inside its body, on the Action's molten orange. Walter Moore settled on it on 2026-11-05 after rounds at 256, 64, 32 and 20 pixels; a flame alone, a smoking stack and the whole foundry were tried and set aside. Two shapes and a flame, no text, so it survives the smallest render.

Layout, so that it can be used anywhere an icon is:

- The chimney fits a 600 × 600 box centred on the 1024 canvas, so the margin is 212 on every side and the dark bounding box is centred to the pixel.
- The farthest dark pixel is 414 from the centre, inside the inscribed circle (512) that circular avatar crops use, and at the 80 % safe zone (410) that the strictest crops keep.
- The background is full-bleed, with no rounded corners and no transparency: hosts round or circle the corners themselves, and transparent pixels show their page background through, which is how an earlier version got white corners on GitHub.

`foundry-bot.png` (1024 × 1024) is the file to upload on the App's settings page under *Display information → Logo*; GitHub has no API for it. `foundry-bot-256.png` is the small export that the READMEs show. To re-render after editing the SVG, on macOS:

```bash
qlmanage -t -s 1024 -o . foundry-bot.svg && mv foundry-bot.svg.png foundry-bot.png
sips -z 256 256 foundry-bot.png --out foundry-bot-256.png
```
