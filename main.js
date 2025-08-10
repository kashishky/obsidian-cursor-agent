'use strict';

const { App, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, ItemView, Modal } = require('obsidian');
const { spawn } = require('child_process');

const DEFAULT_SETTINGS = {
  cliPath: 'cursor',
  workingDirectory: '',
  defaultArgs: '',
  theme: 'obsidian-default',
  maxBufferKb: 2048,
  showTimestamp: true,
};

class CursorAgentPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.registerView(CursorAgentView.VIEW_TYPE, (leaf) => new CursorAgentView(leaf, this));

    this.addRibbonIcon('bot', 'Cursor Agent', () => this.activateView());
    this.addCommand({ id: 'cursor-agent-open', name: 'Open Cursor Agent', callback: () => this.activateView() });

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
    // Preserve user quoting by executing the full command via the shell
    const commandLine = `${this.settings.cliPath}${argsString ? ' ' + argsString : ''}`;
    const child = spawn(commandLine, {
      cwd,
      shell: true,
      env: process.env,
    });

    const maxBytes = this.settings.maxBufferKb * 1024;
    let seenBytes = 0;

    child.stdout.on('data', (data) => {
      seenBytes += data.length;
      if (seenBytes > maxBytes) {
        child.kill('SIGKILL');
        onClose(1, new Error('Output exceeded max buffer'));
        return;
      }
      onData(data.toString('utf8'));
    });

    child.stderr.on('data', (data) => {
      onData(`\n[stderr] ${data.toString('utf8')}`);
    });

    child.on('error', (err) => onClose(1, err));
    child.on('close', (code) => onClose(code));

    try {
      child.stdin.write(prompt);
      child.stdin.end();
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
    header.createEl('div', { text: 'Cursor Agent', cls: 'ca-title' });

    new Setting(header)
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

    const inputWrap = this.themeEl.createEl('div', { cls: 'ca-input-wrap' });
    this.inputEl = inputWrap.createEl('textarea', { cls: 'ca-input', attr: { rows: '3', placeholder: 'Ask the agent…' } });
    const sendBtn = inputWrap.createEl('button', { cls: 'ca-send', text: 'Send' });

    const send = () => this.handleSend();
    sendBtn.addEventListener('click', send);
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
    });
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
    bubble.setText(text);
    return bubble;
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
      .setDesc('Path to Cursor CLI executable (e.g., cursor, /usr/local/bin/cursor)')
      .addText((text) => text
        .setPlaceholder('cursor')
        .setValue(this.plugin.settings.cliPath)
        .onChange(async (value) => {
          this.plugin.settings.cliPath = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Working directory')
      .setDesc('Directory for the CLI process (empty = vault root)')
      .addText((text) => text
        .setPlaceholder('')
        .setValue(this.plugin.settings.workingDirectory)
        .onChange(async (value) => {
          this.plugin.settings.workingDirectory = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Default args')
      .setDesc('Arguments passed to the CLI each run')
      .addText((text) => text
        .setPlaceholder('--model gpt-4.1')
        .setValue(this.plugin.settings.defaultArgs)
        .onChange(async (value) => {
          this.plugin.settings.defaultArgs = value;
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
