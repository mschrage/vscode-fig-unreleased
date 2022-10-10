import { CompletionItemKind, extensions, workspace } from 'vscode'

let useCompletionNiceLook

export const prepareNiceLookingCompletinons = () => {
    const updateStatus = () => {
        useCompletionNiceLook =
            workspace.getConfiguration('workbench', null).get('iconTheme') === 'vscode-icons' && extensions.getExtension('vscode-icons-team.vscode-icons')
    }
    updateStatus()
    workspace.onDidChangeConfiguration(({ affectsConfiguration }) => {
        if (affectsConfiguration('workbench.iconTheme')) updateStatus()
    })
    extensions.onDidChange(updateStatus)
}
export const niceLookingCompletion = (extOrName: string, isFolderKind = false, fallbackKind = CompletionItemKind.Property) =>
    useCompletionNiceLook
        ? {
              kind: isFolderKind ? CompletionItemKind.Folder : CompletionItemKind.File,
              detail: extOrName,
          }
        : {
              kind: fallbackKind,
          }
