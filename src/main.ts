import { App, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, ItemView, Modal, MarkdownView } from 'obsidian';
// @ts-ignore: optional dependency for terminal mode
// eslint-disable-next-line
let pty: any; try { pty = require('node-pty'); } catch {}
// @ts-ignore: optional dependency for terminal widget
let XTerm: any; try { XTerm = require('@xterm/xterm').Terminal; } catch {}
import { spawn } from 'child_process';

interface CursorAgentSettings {
  cliPath: string;
  workingDirectory: string;
  defaultArgs: string;
  theme: ThemeId;
  maxBufferKb: number;
  showTimestamp: boolean;
  inputDirectory: string;
  directoryPresets: string; // deprecated; kept for backwards compat
  backgroundImage: string; // URL or local path
  backgroundOpacity: number; // 0..1
  interactiveMode: boolean; // forward user messages to running process; keep stdin open
  mode: 'chat' | 'terminal';
}

type ThemeId = 'sith' | 'jedi' | 'cowboy-bebop' | 'game-of-thrones' | 'obsidian-default';

const DEFAULT_SETTINGS: CursorAgentSettings = {
  cliPath: 'cursor',
  workingDirectory: '',
  defaultArgs: '',
  theme: 'obsidian-default',
  maxBufferKb: 2048,
  showTimestamp: true,
  inputDirectory: '',
  directoryPresets: '',
  backgroundImage: '',
  backgroundOpacity: 0.2,
  interactiveMode: false,
  mode: 'chat',
};

export default class CursorAgentPlugin extends Plugin {
  settings: CursorAgentSettings = DEFAULT_SETTINGS;
  currentChild: any | null = null;

  async onload() {
    await this.loadSettings();

    this.registerView(CursorAgentView.VIEW_TYPE, (leaf: WorkspaceLeaf) => new CursorAgentView(leaf, this));

    this.addRibbonIcon('bot', 'Three-Eyed Raven', () => this.activateView());
    this.addCommand({
      id: 'cursor-agent-open',
      name: 'Open Three-Eyed Raven',
      callback: () => this.activateView(),
    });

    this.addSettingTab(new CursorAgentSettingTab(this.app, this));
  }

  async onunload() {
    this.app.workspace
      .getLeavesOfType(CursorAgentView.VIEW_TYPE)
      .forEach((l: WorkspaceLeaf) => (l as any).detach?.());
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const existing = workspace.getLeavesOfType(CursorAgentView.VIEW_TYPE);
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      await (leaf as any)?.setViewState?.({ type: CursorAgentView.VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf!);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.app.workspace.trigger('cursor-agent:settings-updated');
  }

  private looksLikeUtf16le(buf: Buffer): boolean {
    if (buf.length >= 2) {
      const bomLE = buf[0] === 0xFF && buf[1] === 0xFE;
      const bomBE = buf[0] === 0xFE && buf[1] === 0xFF;
      if (bomLE || bomBE) return true;
    }
    let zeroCount = 0;
    const sample = Math.min(buf.length, 256);
    for (let i = 1; i < sample; i += 2) if (buf[i] === 0x00) zeroCount++;
    return zeroCount > (sample / 6);
  }

  private decodeChunk(data: Buffer): string {
    let text = this.looksLikeUtf16le(data) ? data.toString('utf16le') : data.toString('utf8');
    // Strip ANSI escape codes
    text = text.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '');
    // Normalize stray CRs
    text = text.replace(/\r(?!\n)/g, '\n');
    return text;
  }

  private toWslPath(p?: string): string {
    if (!p) return '';
    if (/^[A-Za-z]:\\/.test(p)) {
      const drive = p[0].toLowerCase();
      const rest = p.slice(2).replace(/\\/g, '/');
      return `/mnt/${drive}/${rest}`;
    }
    return p;
  }

  runCursorCommand(prompt: string, onData: (chunk: string) => void, onClose: (code: number|null, err?: Error) => void) {
    const argsString = this.settings.defaultArgs?.trim() ?? '';
    const vaultRoot = (this.app.vault.adapter as any)?.getBasePath?.();
    const cwd = this.settings.workingDirectory || vaultRoot || undefined;

    // Execute as a single shell command to preserve user-provided quoting inside Default args.
    // This allows patterns like: wsl.exe bash -lc "cursor-agent --model gpt-5 -p \"$(cat)\""
    const usedPromptToken = /\{prompt(Bash)?\}/.test(argsString);
    const bashEscapedPrompt = `'${prompt.replace(/'/g, `'"'"'`)}'`;
    const substitutedArgs = (argsString)
      .replace(/\{vault\}/g, vaultRoot ?? '')
      .replace(/\{inputDir\}/g, this.settings.inputDirectory ?? '')
      .replace(/\{inputDirWsl\}/g, this.toWslPath(this.settings.inputDirectory))
      .replace(/\{promptBash\}/g, bashEscapedPrompt)
      .replace(/\{prompt\}/g, prompt);
    let child: any;
    const cliPathLower = this.settings.cliPath.toLowerCase();
    const isWsl = cliPathLower.endsWith('wsl.exe') || cliPathLower === 'wsl';
    if (isWsl && this.settings.mode !== 'terminal' /* terminal mode uses pty below */) {
      const m = substitutedArgs.match(/bash\s+-lc\s+(?:(["'])([\s\S]*)\1|(.+))/i);
      let commandInside = m ? (m[2] ?? m[3] ?? '').trim() : substitutedArgs.trim();
      // Auto-apply cd to {inputDirWsl} when using WSL if user did not specify a cd already
      if (!/\bcd\b/i.test(commandInside)) {
        const inputDir = this.settings.inputDirectory?.trim();
        const defaultVault = vaultRoot ? this.toWslPath(vaultRoot) : '';
        const target = inputDir?.length ? this.toWslPath(inputDir) : defaultVault;
        if (target) {
          const qTarget = `'` + String(target).replace(/'/g, `"'"'`) + `'`;
          commandInside = `cd -- ${qTarget} && ${commandInside}`;
        }
      }
      // Use "--" so wsl never treats following args as its own options
      child = spawn(this.settings.cliPath, ['--', 'bash', '-lc', commandInside], {
        // Do NOT pass a Windows cwd to wsl.exe; cd inside bash using {inputDirWsl}
        cwd: undefined,
        shell: false,
      env: process.env,
    });
    } else if (this.settings.mode !== 'terminal') {
      // Linux/macOS native: prefer user Working directory, otherwise Input directory, otherwise vault
      const effectiveCwd = (this.settings.workingDirectory?.trim()
        || this.settings.inputDirectory?.trim()
        || vaultRoot
        || undefined);
      const commandLine = `${this.settings.cliPath}${substitutedArgs ? ' ' + substitutedArgs : ''}`;
      child = spawn(commandLine, { cwd: effectiveCwd, shell: true, env: process.env });
    }

    let killedForSize = false;
    let sawOutput = false;
    const maxBytes = this.settings.maxBufferKb * 1024;
    let seenBytes = 0;

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      const timeoutMs = this.settings.mode === 'terminal' ? 10 * 60 * 1000 : 60 * 1000;
      idleTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        onClose(1, new Error('Process timed out (no output)')); 
      }, timeoutMs);
    };
    let idleTimer: any = null;
    resetIdle();

    child.stdout.on('data', (data: Buffer) => {
      sawOutput = true;
      resetIdle();
      seenBytes += data.length;
      if (seenBytes > maxBytes) {
        killedForSize = true;
        child.kill('SIGKILL');
        onClose(1, new Error('Output exceeded max buffer'));
        return;
      }
      const text = this.settings.mode === 'terminal'
        ? (this.looksLikeUtf16le(data) ? data.toString('utf16le') : data.toString('utf8'))
        : this.decodeChunk(data);
      onData(text);
    });

    child.stderr.on('data', (data: Buffer) => {
      resetIdle();
      const text = this.settings.mode === 'terminal'
        ? (this.looksLikeUtf16le(data) ? data.toString('utf16le') : data.toString('utf8'))
        : this.decodeChunk(data);
      onData(`\n[stderr] ${text}`);
    });

    child.on('error', (err: any) => onClose(1, err));
    child.on('close', (code: number | null) => {
      if (idleTimer) clearTimeout(idleTimer);
      if (this.currentChild === child) this.currentChild = null;
      onClose(code);
    });

    try {
      if (!usedPromptToken) {
        child.stdin.write(prompt + (prompt.endsWith('\n') ? '' : '\n'));
        if (!this.settings.interactiveMode) child.stdin.end();
      }
    } catch (err: any) {
      onClose(1, err);
    }

    if (this.settings.interactiveMode) this.currentChild = child;
    if (this.settings.mode !== 'terminal') return child;

    // Terminal mode with PTY
    if (!pty) {
      onClose(1, new Error('Terminal mode requires node-pty'));
      return null as any;
    }
    const shell = process.platform === 'win32' ? 'wsl.exe' : (process.env.SHELL || 'bash');
    const defaultCwd = (this.settings.workingDirectory?.trim() || this.settings.inputDirectory?.trim() || vaultRoot || undefined) as any;
    const p = pty.spawn(shell, process.platform === 'win32' ? ['--', 'bash', '-lc', 'cursor-agent'] : ['-lc', 'cursor-agent'], {
      name: 'xterm-color',
      cwd: defaultCwd,
      env: process.env as any,
      cols: 120,
      rows: 30,
    });
    this.currentChild = p as any;
    p.onData((data: string) => onData(data));
    p.onExit(({ exitCode }: any) => { this.currentChild = null; onClose(exitCode ?? 0); });
    try {
      if (prompt) p.write(prompt + '\r');
    } catch (e: any) { onClose(1, e); }
    return p as any;
  }
}

class CursorAgentView extends ItemView {
  static VIEW_TYPE = 'cursor-agent-view';
  plugin: CursorAgentPlugin;
  containerEl!: HTMLElement;
  chatEl!: HTMLElement;
  inputEl!: HTMLTextAreaElement;
  themeEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: CursorAgentPlugin) {
    // @ts-ignore
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return CursorAgentView.VIEW_TYPE; }
  getDisplayText() { return 'Cursor Agent'; }
  // Will be overridden visually in the header
  getIcon() { return 'bot'; }

  async onOpen() {
    const root = this.containerEl.children[1] as HTMLElement; // contentEl
    root.empty();

    this.themeEl = root.createEl('div', { cls: ['cursor-agent-root', `theme-${this.plugin.settings.theme}`] });

    const header = this.themeEl.createEl('div', { cls: 'ca-header' });
    // Title removed per request; compact control bar instead
    const actions = header.createEl('div', { cls: 'ca-actions' });
    const dirBadge = actions.createEl('div', { cls: 'ca-dir-badge' });
    const refreshDirBtn = actions.createEl('button', { cls: 'ca-action ca-icon', text: '↻', attr: { title: 'Refresh directory' } });
    const copyAllBtn = actions.createEl('button', { cls: 'ca-action ca-small', text: 'Copy All' });
    const stopBtn = actions.createEl('button', { cls: 'ca-action ca-small', text: 'Stop' });
    const modeSelect = actions.createEl('select', { cls: 'ca-select ca-action', attr: { title: 'Mode' } });
    modeSelect.createEl('option', { text: 'Chat', attr: { value: 'chat' } });
    modeSelect.createEl('option', { text: 'Terminal', attr: { value: 'terminal' } });
    ;(modeSelect as HTMLSelectElement).value = this.plugin.settings.mode;

    const hydrateDir = () => {
      const current = this.plugin.settings.inputDirectory?.trim() || this.plugin.settings.workingDirectory?.trim() || 'vault';
      dirBadge.empty();
      const icon = dirBadge.createEl('span', { text: '📁', cls: 'ca-dir-icon' });
      const text = dirBadge.createEl('span', { text: current, cls: 'ca-dir-text' });
    };
    hydrateDir();
    refreshDirBtn.onclick = hydrateDir;
    copyAllBtn.onclick = () => this.copyAll();
    stopBtn.onclick = () => {
      const child = this.plugin.currentChild as any;
      try { child?.kill?.('SIGINT'); } catch {}
    };
    modeSelect.onchange = async () => {
      const val = (modeSelect as HTMLSelectElement).value as 'chat' | 'terminal';
      this.plugin.settings.mode = val;
      await this.plugin.saveSettings();
      // Rebuild body for terminal mode stub
      this.chatEl.empty();
      if (val === 'terminal' && XTerm) {
        const termHost = this.chatEl.createEl('div', { cls: 'ca-terminal' });
        const term = new XTerm({ cursorBlink: true, convertEol: true, fontSize: 13 });
        // @ts-ignore
        term.open(termHost);
        term.write('\x1b[32mTerminal mode enabled. Type your instruction and press Enter.\x1b[0m\r\n');
        ;(this as any)._xterm = term;
      } else if (val === 'terminal') {
        const fallback = this.chatEl.createEl('div', { cls: 'ca-bubble ca-assistant' });
        fallback.setText('Terminal mode requires xterm.js');
      }
    };

    const themeWrap = header.createEl('div', { cls: 'ca-theme-wrap' });
    const themePicker = new Setting(themeWrap)
      .addDropdown((dd) => dd
        .addOptions({
          'obsidian-default': 'Obsidian',
          'sith': 'Sith',
          'jedi': 'Jedi',
          'cowboy-bebop': 'Cowboy Bebop',
          'game-of-thrones': 'Game of Thrones',
        })
        .setValue(this.plugin.settings.theme)
        .onChange(async (value: string) => {
          this.plugin.settings.theme = value as ThemeId;
          await this.plugin.saveSettings();
          this.themeEl.className = `cursor-agent-root theme-${value}`;
        })
      );

    this.chatEl = this.themeEl.createEl('div', { cls: 'ca-chat' });
    // Background overlay (image/GIF), sits above Obsidian theme background
    const bg = this.chatEl.createEl('div', { cls: 'ca-bg-overlay' });
    const img = this.plugin.settings.backgroundImage?.trim();
    const opacity = this.plugin.settings.backgroundOpacity ?? 0.2;
    const toFileUrl = (p: string) => {
      if (!p) return '';
      if (/^https?:\/\//i.test(p) || /^file:\/\//i.test(p)) return p;
      const normalized = p.replace(/\\/g, '/');
      if (/^[A-Za-z]:\//.test(normalized)) {
        return encodeURI(normalized);
      }
      return encodeURI(normalized);
    };
    if (img) {
      const cssUrl = toFileUrl(img);
      bg.style.setProperty('background-image', `url("${cssUrl}")`);
      (this.chatEl as HTMLElement).style.setProperty('--ca-bg-opacity', String(opacity));
    } else {
      bg.style.display = 'none';
    }

    const inputWrap = this.themeEl.createEl('div', { cls: 'ca-input-wrap' });
    this.inputEl = inputWrap.createEl('textarea', { cls: 'ca-input', attr: { rows: '3', placeholder: 'run, won\'t you' } });
    const sendBtn = inputWrap.createEl('button', { cls: 'ca-send', text: 'Send' });

    const send = () => this.handleSend();
    sendBtn.addEventListener('click', send);
    this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        if (e.shiftKey) return; // Shift+Enter inserts newline
        e.preventDefault();
        send();
      }
    });
  }

  async sendPrompt(prompt: string, onComplete?: (finalText: string) => void) {
    if (!prompt?.trim()) return;
    this.renderBubble('user', prompt);
    const timestamp = this.plugin.settings.showTimestamp ? ` ${new Date().toLocaleTimeString()}` : '';
    const assistantBubble = this.renderBubble('assistant', `Thinking…${timestamp}`);

    let accumulated = '';
    const update = (chunk: string) => {
      accumulated += chunk;
      assistantBubble.setText(accumulated);
      this.chatEl.scrollTop = this.chatEl.scrollHeight;
    };

    const onClose = (code: number | null, err?: Error) => {
      if (err) new Notice(`Cursor agent error: ${err.message}`);
      if (code && code !== 0) new Notice(`Cursor agent exited with code ${code}`);
      if (!accumulated.trim()) accumulated = '(no output)';
      assistantBubble.setText(accumulated);
      onComplete?.(accumulated);
    };

    this.plugin.runCursorCommand(prompt + '\n', update, onClose);
  }

  async handleSend() {
    const prompt = this.inputEl.value.trim();
    if (!prompt) return;

    this.renderBubble('user', prompt);
    this.inputEl.value = '';

    // Terminal mode: treat input messages as direct stdin; spawn plain CLI if not running
    if (this.plugin.settings.mode === 'terminal') {
      const term: any = (this as any)._xterm;
      if (this.plugin.currentChild) {
        try { (this.plugin.currentChild as any)?.stdin?.write(prompt + '\n'); term?.write(`\r\n$ ${prompt}\r\n`);} catch {}
        return;
      }
      const timestamp = this.plugin.settings.showTimestamp ? ` ${new Date().toLocaleTimeString()}` : '';
      const assistantBubble = this.renderBubble('assistant', `Starting terminal…${timestamp}`);
      let accumulated = '';
      const update = (chunk: string) => { accumulated += chunk; assistantBubble.setText(accumulated); this.chatEl.scrollTop = this.chatEl.scrollHeight; };
      const onClose = (code: number | null, err?: Error) => { this.plugin.currentChild = null; if (err) new Notice(err.message); if (code && code !== 0) new Notice(`Exited ${code}`); };
      // Run raw CLI with a real PTY via script; will keep stdin open
      const wslTarget = this.plugin.settings.inputDirectory?.trim()?.length ? this.plugin.settings.inputDirectory : '';
      const toWslLocal = (p?: string) => {
        if (!p) return '';
        if (/^[A-Za-z]:\\/.test(p)) {
          const drive = p[0].toLowerCase();
          const rest = p.slice(2).replace(/\\/g, '/');
          return `/mnt/${drive}/${rest}`;
        }
        return p;
      };
      const cdPrefix = wslTarget ? `cd -- '${toWslLocal(wslTarget).replace(/'/g, "'\"'\"'")}' ; ` : '';
      const rawArgs = `bash -lc "${cdPrefix}script -qefc 'cursor-agent' /dev/null"`;
      const previousArgs = this.plugin.settings.defaultArgs;
      this.plugin.settings.defaultArgs = rawArgs;
      this.plugin.settings.interactiveMode = true;
      this.plugin.currentChild = this.plugin.runCursorCommand('', (chunk) => { term?.write(chunk); update(chunk); }, onClose);
      this.plugin.settings.defaultArgs = previousArgs;
      return;
    }

    // If an interactive process is running, forward input to stdin instead of starting a new one
    if (this.plugin.currentChild && this.plugin.settings.interactiveMode) {
      try { (this.plugin.currentChild as any)?.stdin?.write(prompt + '\n'); } catch {}
      return;
    }

    const timestamp = this.plugin.settings.showTimestamp ? ` ${new Date().toLocaleTimeString()}` : '';
    const assistantBubble = this.renderBubble('assistant', `Thinking…${timestamp}`);

    let accumulated = '';
    const update = (chunk: string) => {
      accumulated += chunk;
      assistantBubble.setText(accumulated);
      this.chatEl.scrollTop = this.chatEl.scrollHeight;
    };

    const onClose = (code: number | null, err?: Error) => {
      if (err) new Notice(`Cursor agent error: ${err.message}`);
      if (code && code !== 0) new Notice(`Cursor agent exited with code ${code}`);
      if (!accumulated.trim()) accumulated = '(no output)';
      assistantBubble.setText(accumulated);
    };

    this.plugin.runCursorCommand(prompt + '\n', update, onClose);
  }

  renderBubble(role: 'user' | 'assistant', text: string) {
    const bubble = this.chatEl.createEl('div', { cls: ['ca-bubble', `ca-${role}`] });
    const body = bubble.createEl('div', { cls: 'ca-bubble-body' });
    body.setText(text);
    const actions = bubble.createEl('div', { cls: 'ca-bubble-actions' });
    const copyBtn = actions.createEl('button', { cls: 'ca-action ca-chip', text: 'Copy' });
    const pasteBtn = actions.createEl('button', { cls: 'ca-action ca-chip', text: 'Paste' });
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(body.innerText);
      new Notice('Copied');
    };
    pasteBtn.onclick = () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const editor = view?.editor;
      if (!editor) { new Notice('Open a Markdown note to paste'); return; }
      editor.replaceSelection(body.innerText + '\n');
      new Notice('Pasted');
    };
    return body;
  }

  private async copyAll() {
    const content = Array.from(this.chatEl.querySelectorAll('.ca-bubble .ca-bubble-body'))
      .map((el) => (el as HTMLElement).innerText)
      .join('\n');
    await navigator.clipboard.writeText(content);
    new Notice('Copied conversation to clipboard');
  }

  private pasteToActiveNote() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) { new Notice('Open a note to paste'); return; }
    const content = Array.from(this.chatEl.querySelectorAll('.ca-bubble'))
      .map((el) => (el as HTMLElement).innerText)
      .join('\n');
    const editor = view.editor;
    editor.replaceSelection(content + '\n');
    new Notice('Pasted conversation into note');
  }

  async onClose() {}
}

class CursorAgentSettingTab extends PluginSettingTab {
  plugin: CursorAgentPlugin;

  constructor(app: App, plugin: CursorAgentPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Cursor Agent Settings' });

    new Setting(containerEl)
      .setName('CLI path')
      .setDesc('Windows (with WSL): C:\\Windows\\System32\\wsl.exe (recommended). Linux/macOS: cursor-agent.')
      .addText((text) => text
        .setPlaceholder('wsl.exe or cursor-agent')
        .setValue(this.plugin.settings.cliPath)
        .onChange(async (value: string) => {
          this.plugin.settings.cliPath = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Working directory')
      .setDesc('Process cwd. Use only for Windows-native CLIs. Leave empty when using WSL; instead cd inside Default args.')
      .addText((text) => text
        .setPlaceholder('')
        .setValue(this.plugin.settings.workingDirectory)
        .onChange(async (value: string) => {
          this.plugin.settings.workingDirectory = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Input directory')
      .setDesc('Windows path for your project. Tokens: {inputDir} (Windows), {inputDirWsl} (auto-converted). Recommended for WSL flows.')
      .addText((text) => text
        .setPlaceholder('C:\\path\\to\\project')
        .setValue(this.plugin.settings.inputDirectory)
        .onChange(async (value: string) => {
          this.plugin.settings.inputDirectory = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Directory presets')
      .setDesc('Semicolon-separated list of Windows paths for the chat dropdown')
      .addText((text) => text
        .setPlaceholder('C:\\code;D:\\workspace')
        .setValue(this.plugin.settings.directoryPresets)
        .onChange(async (value: string) => {
          this.plugin.settings.directoryPresets = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Chat background (image/GIF)')
      .setDesc('URL; overlaid translucent image above Obsidian background')
      .addText((text) => text
        .setPlaceholder('https://… or C:\\path\\image.png')
        .setValue(this.plugin.settings.backgroundImage)
        .onChange(async (value: string) => {
          this.plugin.settings.backgroundImage = value.trim();
          await this.plugin.saveSettings();
          this.app.workspace.trigger('cursor-agent:settings-updated');
        }));

    new Setting(containerEl)
      .setName('Chat background opacity')
      .setDesc('0.0 (invisible) to 1.0 (opaque)')
      .addText((text) => text
        .setPlaceholder('0.2')
        .setValue(String(this.plugin.settings.backgroundOpacity))
        .onChange(async (value: string) => {
          const v = Number(value);
          if (!Number.isNaN(v) && v >= 0 && v <= 1) {
            this.plugin.settings.backgroundOpacity = v;
            await this.plugin.saveSettings();
            this.app.workspace.trigger('cursor-agent:settings-updated');
          }
        }));

    new Setting(containerEl)
      .setName('Default args')
      .setDesc('Command/flags sent to the CLI. For WSL, wrap in bash -lc and use {promptBash}. Include cd yourself or it will be injected.')
      .addText((text) => text
        .setPlaceholder('bash -lc "cd {inputDirWsl}; cursor-agent -p {promptBash} --model gpt-5 --output-format text"')
        .setValue(this.plugin.settings.defaultArgs)
        .onChange(async (value: string) => {
          this.plugin.settings.defaultArgs = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Interactive mode')
      .setDesc('Keep the process running and send subsequent messages to its stdin (for Y/N prompts).')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.interactiveMode)
        .onChange(async (value: boolean) => {
          this.plugin.settings.interactiveMode = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Max buffer (KB)')
      .setDesc('Kill process if output exceeds this size')
      .addText((text) => text
        .setPlaceholder('2048')
        .setValue(String(this.plugin.settings.maxBufferKb))
        .onChange(async (value: string) => {
          const parsed = Number(value);
          if (!Number.isNaN(parsed) && parsed > 0) {
            this.plugin.settings.maxBufferKb = parsed;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('Show timestamps')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.showTimestamp)
        .onChange(async (value: boolean) => {
          this.plugin.settings.showTimestamp = value;
          await this.plugin.saveSettings();
        }));
  }
}

class PromptModal extends Modal {
  private placeholder: string;
  private resolveFn?: (value: string | null) => void;
  private inputEl!: HTMLTextAreaElement;

  constructor(app: App, placeholder = 'Type your instruction…') {
    super(app);
    this.placeholder = placeholder;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Ask Cursor Agent' });
    this.inputEl = contentEl.createEl('textarea', { attr: { rows: '4', placeholder: this.placeholder }, cls: 'ca-input' });
    const buttons = contentEl.createEl('div', { cls: 'ca-input-wrap' });
    const cancelBtn = buttons.createEl('button', { text: 'Cancel' });
    const okBtn = buttons.createEl('button', { text: 'Send', cls: 'ca-send' });
    cancelBtn.onClickEvent(() => { this.close(); this.resolveFn?.(null); });
    okBtn.onClickEvent(() => { const v = this.inputEl.value; this.close(); this.resolveFn?.(v); });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  waitForInput(): Promise<string | null> {
    return new Promise((resolve) => { this.resolveFn = resolve; });
  }
}
