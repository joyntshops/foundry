# Assets

`foundry-bot.svg` is the bot icon of the public Foundry GitHub App: the README's furnace condensed to the body, one arched firebox with its flame, and the smoke above, on the Action's molten orange. It was chosen by Walter Moore on 2026-11-03 from candidates tested at 20 and 40 pixels on GitHub's light and dark themes, which is why it has three shapes and no text.

`foundry-bot.png` (1024 × 1024) is the file to upload on the App's settings page under *Display information → Logo*; GitHub has no API for it. `foundry-bot-256.png` is the small export. Both are rendered full-bleed, without the SVG's rounded corners: GitHub crops avatars to its own shape and shows its page background through transparent pixels, so a rounded upload gets white corners.

To re-render after editing the SVG, on macOS:

```bash
sed 's/rx="224" //' foundry-bot.svg > square.svg
qlmanage -t -s 1024 -o . square.svg && mv square.svg.png foundry-bot.png && rm square.svg
sips -z 256 256 foundry-bot.png --out foundry-bot-256.png
```
