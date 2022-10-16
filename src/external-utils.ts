import { CompletionItem, CompletionItemKind, extensions, Uri, workspace } from 'vscode'

// #region vscode related
let useCompletionNiceLook: boolean

export const prepareNiceLookingCompletinons = () => {
    const updateStatus = () => {
        useCompletionNiceLook =
            workspace.getConfiguration('workbench', null).get('iconTheme') === 'vscode-icons' && !!extensions.getExtension('vscode-icons-team.vscode-icons')
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

export const getCompletionLabelName = ({ label }: Pick<CompletionItem, 'label'>) => (typeof label === 'string' ? label : label.label)

export const urisToDocuments = async (uris: Uri[]) => {
    return await Promise.all(uris.map(uri => workspace.openTextDocument(uri)))
}

// #endregion
// general purpose

/**
 * Type-friendly version of `[].includes()`
 * For example when used with string union, it would give you autocomplete
 */
export const oneOf = <T, K extends T>(value: T, ...values: [...K[]]): boolean => values.includes(value as any)
