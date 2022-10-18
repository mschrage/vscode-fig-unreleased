vi.mock('vscode', () => ({
    commands: {
        registerCommand() {},
    },
    languages: new Proxy(
        {},
        {
            get(target, p, receiver) {
                return () => {}
            },
        },
    ),
    workspace: {
        registerFileSystemProvider() {},
        onDidRenameFiles() {},
    },
    window: {
        onDidChangeTextEditorSelection() {},
        onDidChangeActiveTextEditor() {},
    },
    SemanticTokensLegend: class {},
    EventEmitter: class {},
}))

export {}
