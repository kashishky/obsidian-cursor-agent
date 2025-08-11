declare module 'obsidian' {
  export class App {
    vault: any;
    workspace: any;
  }
  export class Notice {
    constructor(message: string);
  }
  export class Plugin {
    app: App;
    addRibbonIcon(...args: any[]): any;
    addCommand(...args: any[]): any;
    addSettingTab(tab: any): any;
    registerView(type: string, factory: any): any;
    loadData(): Promise<any>;
    saveData(data: any): Promise<void>;
  }
  export class PluginSettingTab {
    app: App;
    containerEl: HTMLElement;
    constructor(app: App, plugin: any);
    display(): void;
  }
  export class Setting {
    constructor(containerEl: HTMLElement);
    setName(name: string): this;
    setDesc(desc: string): this;
    addText(cb: (t: any) => any): this;
    addToggle(cb: (t: any) => any): this;
    addDropdown(cb: (d: any) => any): this;
  }
  export class WorkspaceLeaf {
    detach?: () => void;
    setViewState?: (v: any) => Promise<void> | void;
  }
  export class ItemView {
    containerEl: HTMLElement;
    app: App;
    constructor(leaf: WorkspaceLeaf);
    getViewType(): string;
    getDisplayText(): string;
    getIcon(): string;
    onOpen(): Promise<void> | void;
    onClose(): Promise<void> | void;
  }
  export class Modal {
    contentEl: HTMLElement;
    constructor(app: App);
    open(): void;
    close(): void;
    onOpen(): void;
    onClose(): void;
  }
  export class MarkdownView { editor: { replaceSelection(s: string): void } }
}

declare module 'child_process' {
  // Loosen signature so spawn(command, options) type-checks
  export function spawn(command: string, ...rest: any[]): any;
}

declare var process: any;
declare var Buffer: any;
declare type Buffer = any;

// DOM helpers Obsidian adds on HTMLElements
interface HTMLElement {
  empty: () => void;
  createEl: (tag: string, options?: any) => any;
}


