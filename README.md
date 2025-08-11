# Cursor Agent for Obsidian

Integrate an external Cursor CLI agent into Obsidian with a live-streaming chat view and multiple visual themes (Sith, Jedi, Cowboy Bebop, Game of Thrones).

## Features
- Chat UI as a right-side view
- Streams stdout from your configured CLI (e.g., Cursor CLI)
- Theme picker: Obsidian, Sith, Jedi, Cowboy Bebop, Game of Thrones
- Configurable CLI path, args, working directory, buffer limit, timestamps

## Installation (Development)
1. Clone this repo into your vault's `.obsidian/plugins` folder:
   ```bash
   git clone https://github.com/yourname/obsidian-cursor-agent \
     "$VAULT/.obsidian/plugins/cursor-agent"
   ```
2. Install deps and build:
   ```bash
   npm install
   npm run build
   ```
3. In Obsidian, enable the plugin in Settings → Community Plugins.

## Manual Install (Release build)
Download the release assets and copy `main.js`, `manifest.json`, and `styles.css` into a folder named `cursor-agent` under `.obsidian/plugins`.

## Settings
- CLI path
  - Windows (with WSL): `C:\\Windows\\System32\\wsl.exe` (recommended)
  - Linux/macOS: `cursor-agent`
- Working directory
  - Process cwd for Windows-native CLIs only. Leave empty for WSL.
- Input directory
  - Windows project path. Tokens: `{inputDir}` (Windows) and `{inputDirWsl}` (auto-converted for WSL).
  - If both Working directory and Input directory are empty, the plugin defaults to your Obsidian vault directory.
- Default args
  - For WSL (recommended):
    - `bash -lc "cursor-agent -p {promptBash} --model gpt-5 --output-format text"`
      - The plugin will inject `cd` to `{inputDirWsl}` if set, otherwise to the vault path. If you provide your own `cd` in the command, the plugin will not inject one.
  - For Linux/macOS (native):
    - `-p {promptBash} --model gpt-5 --output-format text`
- Chat background
  - URL or absolute file path for a translucent image/GIF overlay (sits above the Obsidian theme background)
  - Opacity 0.0–1.0
- Max buffer (KB)
  - Kill process if output exceeds this size
- Show timestamps
  - Toggle timestamps in assistant messages

## How it works
The plugin launches your CLI using Node's `child_process.spawn`, writes the prompt to stdin, and streams stdout into the chat view.

## Windows + WSL quick start
1. Set `CLI path` to `C:\\Windows\\System32\\wsl.exe`.
2. Optional: Set `Input directory` to your Windows project path (otherwise vault is used).
3. Set `Default args` to:
   ```
   bash -lc "cursor-agent -p {promptBash} --model gpt-5 --output-format text"
   ```
4. Use the chat view. The header shows the effective directory; click ↻ to refresh.

## Linux/macOS quick start
1. Set `CLI path` to `cursor-agent`.
2. Leave `Working directory` as needed (optional).
3. Set `Default args` to:
   ```
   -p {promptBash} --model gpt-5 --output-format text
   ```

## Licensing
MIT License (see `LICENSE`).
