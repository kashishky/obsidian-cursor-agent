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
- CLI path: full path or `cursor`
- Working directory: defaults to vault root
- Default args: passed to the CLI
- Max buffer (KB): kill process if output exceeds this size
- Show timestamps: toggle timestamps in assistant messages

## How it works
The plugin launches your CLI using Node's `child_process.spawn`, writes the prompt to stdin, and streams stdout into the chat view.

## Licensing
MIT License (see `LICENSE`).
