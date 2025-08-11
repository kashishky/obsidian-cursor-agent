'use strict';

const { App, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, ItemView, Modal, MarkdownView } = require('obsidian');
const { spawn } = require('child_process');

const DEFAULT_SETTINGS = {
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

class CursorAgentPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.registerView(CursorAgentView.VIEW_TYPE, (leaf) => new CursorAgentView(leaf, this));

    this.addRibbonIcon('bot', 'Three-Eyed Raven', () => this.activateView());
    this.addCommand({ id: 'cursor-agent-open', name: 'Open Three-Eyed Raven', callback: () => this.activateView() });

    this.addSettingTab(new CursorAgentSettingTab(this.app, this));
  }

  async onunload() {
    this.app.workspace.getLeavesOfType(CursorAgentView.VIEW_TYPE).forEach((leaf) => leaf.detach());
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = null;
    const existing = workspace.getLeavesOfType(CursorAgentView.VIEW_TYPE);
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      await (leaf == null ? void 0 : leaf.setViewState({ type: CursorAgentView.VIEW_TYPE, active: true }));
    }
    workspace.revealLeaf(leaf);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.app.workspace.trigger('cursor-agent:settings-updated');
  }

  runCursorCommand(prompt, onData, onClose) {
    const argsString = (this.settings.defaultArgs && this.settings.defaultArgs.trim()) || '';
    const vaultRoot = this.app.vault.adapter && typeof this.app.vault.adapter.getBasePath === 'function'
      ? this.app.vault.adapter.getBasePath()
      : undefined;
    const cwd = this.settings.workingDirectory || vaultRoot || undefined;
    // Token substitution helpers
    const toWslPath = (p) => {
      if (!p) return '';
      if (/^[A-Za-z]:\\/.test(p)) {
        const drive = p[0].toLowerCase();
        const rest = p.slice(2).replace(/\\/g, '/');
        return `/mnt/${drive}/${rest}`;
      }
      return p;
    };
    const usedPromptToken = /\{prompt(Bash)?\}/.test(argsString);
    const bashEscapedPrompt = `'${String(prompt).replace(/'/g, `'"'"'`)}'`;
    const substitutedArgs = (argsString)
      .replace(/\{vault\}/g, vaultRoot || '')
      .replace(/\{inputDir\}/g, this.settings.inputDirectory || '')
      .replace(/\{inputDirWsl\}/g, toWslPath(this.settings.inputDirectory))
      .replace(/\{promptBash\}/g, bashEscapedPrompt)
      .replace(/\{prompt\}/g, String(prompt));
    let child;
    const cliPathLower = this.settings.cliPath.toLowerCase();
    const isWsl = cliPathLower.endsWith('wsl.exe') || cliPathLower === 'wsl';
    if (isWsl) {
      const m = substitutedArgs.match(/bash\s+-lc\s+(?:(["'])([\s\S]*)\1|(.+))/i);
      let commandInside = m ? (m[2] || m[3] || '').trim() : substitutedArgs.trim();
      if (!/\bcd\b/i.test(commandInside)) {
        const inputDir = (this.settings.inputDirectory || '').trim();
        const defaultVault = toWslPath(vaultRoot || '');
        const target = inputDir.length ? toWslPath(inputDir) : defaultVault;
        if (target) {
          const qTarget = `'` + String(target).replace(/'/g, `"'"'`) + `'`;
          commandInside = `cd -- ${qTarget} && ${commandInside}`;
        }
      }
      child = spawn(this.settings.cliPath, ['--', 'bash', '-lc', commandInside], { cwd: undefined, shell: false, env: process.env });
    } else {
      const commandLine = `${this.settings.cliPath}${substitutedArgs ? ' ' + substitutedArgs : ''}`;
      child = spawn(commandLine, { cwd, shell: true, env: process.env });
    }

    const maxBytes = this.settings.maxBufferKb * 1024;
    let seenBytes = 0;
    let sawOutput = false;

    const looksLikeUtf16le = (buf) => {
      if (buf.length >= 2) {
        const bomLE = buf[0] === 0xFF && buf[1] === 0xFE;
        const bomBE = buf[0] === 0xFE && buf[1] === 0xFF;
        if (bomLE || bomBE) return true;
      }
      let zeroCount = 0;
      const sample = Math.min(buf.length, 256);
      for (let i = 1; i < sample; i += 2) if (buf[i] === 0x00) zeroCount++;
      return zeroCount > (sample / 6);
    };
    const decodeChunk = (data) => {
      let text = looksLikeUtf16le(data) ? data.toString('utf16le') : data.toString('utf8');
      text = text.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '');
      text = text.replace(/\r(?!\n)/g, '\n');
      return text;
    };

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        onClose(1, new Error('Process timed out (no output)'));
      }, 60000);
    };
    let idleTimer = null;
    resetIdle();

    child.stdout.on('data', (data) => {
      sawOutput = true;
      resetIdle();
      seenBytes += data.length;
      if (seenBytes > maxBytes) {
        child.kill('SIGKILL');
        onClose(1, new Error('Output exceeded max buffer'));
        return;
      }
      onData(decodeChunk(data));
    });

    child.stderr.on('data', (data) => {
      resetIdle();
      onData(`\n[stderr] ${decodeChunk(data)}`);
    });

    child.on('error', (err) => onClose(1, err));
    child.on('close', (code) => {
      if (idleTimer) clearTimeout(idleTimer);
      onClose(code);
    });

    try {
      if (!usedPromptToken) {
        child.stdin.write(prompt);
        child.stdin.end();
      }
    } catch (err) {
      onClose(1, err);
    }

    return child;
  }
}

class CursorAgentView extends ItemView {
  static VIEW_TYPE = 'cursor-agent-view';

  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return CursorAgentView.VIEW_TYPE; }
  getDisplayText() { return 'Cursor Agent'; }
  getIcon() { return 'bot'; }

  async onOpen() {
    const root = this.containerEl.children[1];
    root.empty();

    this.themeEl = root.createEl('div', { cls: ['cursor-agent-root', `theme-${this.plugin.settings.theme}`] });

    const header = this.themeEl.createEl('div', { cls: 'ca-header' });
    const actions = header.createEl('div', { cls: 'ca-actions' });
    const dirBadge = actions.createEl('div', { cls: 'ca-dir-badge' });
    const refreshDirBtn = actions.createEl('button', { cls: 'ca-action ca-icon', text: '↻' });
    const copyAllBtn = actions.createEl('button', { cls: 'ca-action ca-small', text: 'Copy All' });
    const stopBtn = actions.createEl('button', { cls: 'ca-action ca-small', text: 'Stop' });
    const modeSelect = actions.createEl('select', { cls: 'ca-select ca-action' });
    modeSelect.createEl('option', { text: 'Chat', attr: { value: 'chat' } });
    modeSelect.createEl('option', { text: 'Terminal', attr: { value: 'terminal' } });
    modeSelect.value = this.plugin.settings.mode;

    const hydrateDir = () => {
      const current = (this.plugin.settings.inputDirectory || '').trim() || (this.plugin.settings.workingDirectory || '').trim() || 'vault';
      dirBadge.empty();
      dirBadge.createEl('span', { text: '📁', cls: 'ca-dir-icon' });
      dirBadge.createEl('span', { text: current, cls: 'ca-dir-text' });
    };
    hydrateDir();
    refreshDirBtn.onclick = hydrateDir;
    copyAllBtn.onclick = async () => {
      const content = Array.from(this.chatEl.querySelectorAll('.ca-bubble .ca-bubble-body')).map((el) => el.innerText).join('\n');
      await navigator.clipboard.writeText(content);
      new Notice('Copied conversation to clipboard');
    };
    stopBtn.onclick = () => { try { this.plugin.currentChild?.kill?.('SIGINT'); } catch {} };
    modeSelect.onchange = async () => {
      this.plugin.settings.mode = modeSelect.value;
      await this.plugin.saveSettings();
      this.chatEl.empty();
      if (modeSelect.value === 'terminal') {
        const info = this.chatEl.createEl('div', { cls: 'ca-bubble ca-assistant' });
        info.setText('Terminal mode enabled. Type commands and press Enter.');
      }
    };

    const themeWrap = header.createEl('div', { cls: 'ca-theme-wrap' });
    new Setting(themeWrap)
      .addDropdown((dd) => dd
        .addOptions({
          'obsidian-default': 'Obsidian',
          'sith': 'Sith',
          'jedi': 'Jedi',
          'cowboy-bebop': 'Cowboy Bebop',
          'game-of-thrones': 'Game of Thrones',
        })
        .setValue(this.plugin.settings.theme)
        .onChange(async (value) => {
          this.plugin.settings.theme = value;
          await this.plugin.saveSettings();
          this.themeEl.className = `cursor-agent-root theme-${value}`;
        })
      );

    this.chatEl = this.themeEl.createEl('div', { cls: 'ca-chat' });
    const bg = this.chatEl.createEl('div', { cls: 'ca-bg-overlay' });
    const img = (this.plugin.settings.backgroundImage || '').trim();
    const opacity = this.plugin.settings.backgroundOpacity ?? 0.2;
    const toFileUrl = (p) => {
      if (!p) return '';
      if (/^https?:\/\//i.test(p) || /^file:\/\//i.test(p)) return p;
      const normalized = p.replace(/\\/g, '/');
      if (/^[A-Za-z]:\//.test(normalized)) {
        return 'file:///' + encodeURI(normalized);
      }
      return 'file://' + encodeURI(normalized);
    };
    if (img) {
      const cssUrl = toFileUrl(img);
      bg.style.setProperty('background-image', `url("${cssUrl}")`);
      this.chatEl.style.setProperty('--ca-bg-opacity', String(opacity));
    } else {
      bg.style.display = 'none';
    }

    const inputWrap = this.themeEl.createEl('div', { cls: 'ca-input-wrap' });
    this.inputEl = inputWrap.createEl('textarea', { cls: 'ca-input', attr: { rows: '3', placeholder: 'run won\'t you…' } });
    const sendBtn = inputWrap.createEl('button', { cls: 'ca-send', text: 'Send' });

    const send = () => this.handleSend();
    sendBtn.addEventListener('click', send);
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (e.shiftKey) return;
        e.preventDefault();
        send();
      }
    });

    // per-message actions are added in renderBubble
  }

  async sendPrompt(prompt, onComplete) {
    if (!prompt || !prompt.trim()) return;
    this.renderBubble('user', prompt);
    const timestamp = this.plugin.settings.showTimestamp ? ` ${new Date().toLocaleTimeString()}` : '';
    const assistantBubble = this.renderBubble('assistant', `Thinking…${timestamp}`);

    let accumulated = '';
    const update = (chunk) => {
      accumulated += chunk;
      assistantBubble.setText(accumulated);
      this.chatEl.scrollTop = this.chatEl.scrollHeight;
    };

    const onClose = (code, err) => {
      if (err) new Notice(`Cursor agent error: ${err.message}`);
      if (code && code !== 0) new Notice(`Cursor agent exited with code ${code}`);
      if (typeof onComplete === 'function') onComplete(accumulated);
    };

    this.plugin.runCursorCommand(prompt + '\n', update, onClose);
  }

  async handleSend() {
    const prompt = this.inputEl.value.trim();
    if (!prompt) return;

    this.renderBubble('user', prompt);
    this.inputEl.value = '';

    const timestamp = this.plugin.settings.showTimestamp ? ` ${new Date().toLocaleTimeString()}` : '';
    const assistantBubble = this.renderBubble('assistant', `Thinking…${timestamp}`);

    let accumulated = '';
    const update = (chunk) => {
      accumulated += chunk;
      assistantBubble.setText(accumulated);
      this.chatEl.scrollTop = this.chatEl.scrollHeight;
    };

    const onClose = (code, err) => {
      if (err) new Notice(`Cursor agent error: ${err.message}`);
      if (code && code !== 0) new Notice(`Cursor agent exited with code ${code}`);
    };

    this.plugin.runCursorCommand(prompt + '\n', update, onClose);
  }

  renderBubble(role, text) {
    const bubble = this.chatEl.createEl('div', { cls: ['ca-bubble', `ca-${role}`] });
    const body = bubble.createEl('div', { cls: 'ca-bubble-body' });
    body.setText(text);
    const actions = bubble.createEl('div', { cls: 'ca-bubble-actions' });
    const copyBtn = actions.createEl('button', { cls: 'ca-action ca-chip', text: 'Copy' });
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(body.innerText);
      new Notice('Copied');
    };
    return body;
  }
}

class CursorAgentSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Cursor Agent Settings' });

    new Setting(containerEl)
      .setName('CLI path')
      .setDesc('Windows (with WSL): C:\\Windows\\System32\\wsl.exe. Linux/macOS: cursor-agent.')
      .addText((text) => text
        .setPlaceholder('wsl.exe or cursor-agent')
        .setValue(this.plugin.settings.cliPath)
        .onChange(async (value) => {
          this.plugin.settings.cliPath = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Working directory')
      .setDesc('Process cwd. Use only for Windows-native CLIs. Leave empty for WSL; instead cd inside Default args.')
      .addText((text) => text
        .setPlaceholder('')
        .setValue(this.plugin.settings.workingDirectory)
        .onChange(async (value) => {
          this.plugin.settings.workingDirectory = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Input directory')
      .setDesc('Windows path for your project. Tokens: {inputDir} (Windows), {inputDirWsl} (auto-converted for WSL).')
      .addText((text) => text
        .setPlaceholder('C:\\path\\to\\project')
        .setValue(this.plugin.settings.inputDirectory)
        .onChange(async (value) => {
          this.plugin.settings.inputDirectory = value.trim();
          await this.plugin.saveSettings();
          this.app.workspace.trigger('cursor-agent:settings-updated');
        }));

    new Setting(containerEl)
      .setName('Chat background (image/GIF)')
      .setDesc('URL or absolute file path; overlaid translucent image above Obsidian background')
      .addText((text) => text
        .setPlaceholder('https://… or C:\\path\\image.png')
        .setValue(this.plugin.settings.backgroundImage)
        .onChange(async (value) => {
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
        .onChange(async (value) => {
          const v = Number(value);
          if (!Number.isNaN(v) && v >= 0 && v <= 1) {
            this.plugin.settings.backgroundOpacity = v;
            await this.plugin.saveSettings();
            this.app.workspace.trigger('cursor-agent:settings-updated');
          }
        }));

    new Setting(containerEl)
      .setName('Default args')
      .setDesc('For WSL, use: bash -lc "cursor-agent -p {promptBash} --model gpt-5 --output-format text" (cd is injected if not provided)')
      .addText((text) => text
        .setPlaceholder('bash -lc "cd {inputDirWsl}; cursor-agent -p {promptBash} --model gpt-5 --output-format text"')
        .setValue(this.plugin.settings.defaultArgs)
        .onChange(async (value) => {
          this.plugin.settings.defaultArgs = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Interactive mode')
      .setDesc('Keep the process running and send subsequent messages to stdin (for Y/N prompts).')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.interactiveMode)
        .onChange(async (value) => {
          this.plugin.settings.interactiveMode = value;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('Max buffer (KB)')
      .setDesc('Kill process if output exceeds this size')
      .addText((text) => text
        .setPlaceholder('2048')
        .setValue(String(this.plugin.settings.maxBufferKb))
        .onChange(async (value) => {
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
        .onChange(async (value) => {
          this.plugin.settings.showTimestamp = value;
          await this.plugin.saveSettings();
        }));
  }
}

class PromptModal extends Modal {
  constructor(app, placeholder = 'Type your instruction…') {
    super(app);
    this.placeholder = placeholder;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Ask Cursor Agent' });
    this.inputEl = contentEl.createEl('textarea', { attr: { rows: '4', placeholder: this.placeholder }, cls: 'ca-input' });
    const buttons = contentEl.createEl('div', { cls: 'ca-input-wrap' });
    const cancelBtn = buttons.createEl('button', { text: 'Cancel' });
    const okBtn = buttons.createEl('button', { text: 'Send', cls: 'ca-send' });
    cancelBtn.onClickEvent(() => { this.close(); if (this.resolveFn) this.resolveFn(null); });
    okBtn.onClickEvent(() => { const v = this.inputEl.value; this.close(); if (this.resolveFn) this.resolveFn(v); });
  }
  onClose() { this.contentEl.empty(); }
  waitForInput() { return new Promise((resolve) => { this.resolveFn = resolve; }); }
}

module.exports = CursorAgentPlugin;
module.exports.default = CursorAgentPlugin;
